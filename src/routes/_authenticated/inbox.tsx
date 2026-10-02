import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive, FileText, Image as ImageIcon, Search, Star, Trash2, Download, Inbox as InboxIcon, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { fetchMyOrgs } from "@/lib/queries";
import { can } from "@/lib/roles";
import { getFileUrl, deleteItem } from "@/lib/files.functions";
import { fmtSize, fmtTime } from "@/lib/upload";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";

export const Route = createFileRoute("/_authenticated/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox — DentalHub" },
      { name: "description", content: "Nowe pliki ze wszystkich Twoich gabinetów." },
      { property: "og:title", content: "Inbox — DentalHub" },
      { property: "og:description", content: "Nowe pliki ze wszystkich Twoich gabinetów." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: InboxPage,
});

type Item = {
  id: string;
  org_id: string;
  file_name: string;
  size_bytes: number;
  mime_type: string;
  sender_name: string | null;
  note: string | null;
  important: boolean;
  read_at: string | null;
  archived_at: string | null;
  created_at: string;
  direction: string;
  recipient_user_id: string | null;
};

function InboxPage() {
  const qc = useQueryClient();
  const [org, setOrg] = useState<string>("all");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"new" | "archive">("new");
  const [open, setOpen] = useState<{ item: Item; url: string } | null>(null);
  const openFile = useServerFn(getFileUrl);
  const del = useServerFn(deleteItem);

  const orgs = useQuery({ queryKey: ["orgs"], queryFn: fetchMyOrgs });
  const items = useQuery({
    queryKey: ["items"],
    queryFn: async () => {
      const { data, error } = await supabase.from("items").select("*").order("created_at", { ascending: false }).limit(500);
      if (error) throw error;
      return data as Item[];
    },
  });

  useEffect(() => {
    const ch = supabase
      .channel("items-inbox")
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, (p) => {
        if (p.eventType === "INSERT") toast("Nowy plik w inboksie");
        qc.invalidateQueries({ queryKey: ["items"] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const orgName = (id: string) => orgs.data?.find((o) => o.id === id)?.name ?? "";
  const roleIn = (id: string) => orgs.data?.find((o) => o.id === id)?.role ?? "";
  const hasPersonal = (orgs.data ?? []).some((o) => can.personalInbox(o.role));
  const hasClinic = (orgs.data ?? []).some((o) => o.kind !== "personal" && can.clinicInbox(o.role));
  const [boxPref, setBox] = useState<"me" | "clinic">("me");
  const box: "me" | "clinic" = !hasPersonal && hasClinic ? "clinic" : !hasClinic ? "me" : boxPref;
  const inBox = (i: Item) => (box === "me" ? !!i.recipient_user_id : !i.recipient_user_id);
  const canDelete = (i: Item) => !!i.recipient_user_id || can.deleteClinicFiles(roleIn(i.org_id));
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (items.data ?? []).filter(
      (i) =>
        inBox(i) &&
        (view === "new" ? !i.archived_at : !!i.archived_at) &&
        (org === "all" || i.org_id === org) &&
        (!s || [i.file_name, i.note, i.sender_name].some((v) => v?.toLowerCase().includes(s))),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.data, q, org, view, box]);

  const unread = (id?: string, b: "me" | "clinic" = box) =>
    (items.data ?? []).filter(
      (i) => !i.read_at && !i.archived_at && (b === "me" ? !!i.recipient_user_id : !i.recipient_user_id) && (!id || i.org_id === id),
    ).length;
  const chipOrgs = (orgs.data ?? []).filter((o) => (box === "me" ? can.personalInbox(o.role) : o.kind !== "personal" && can.clinicInbox(o.role)));

  async function update(id: string, patch: Partial<Item>) {
    qc.setQueryData<Item[]>(["items"], (old) => old?.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    const { error } = await supabase.from("items").update(patch).eq("id", id);
    if (error) toast.error("Nie udało się zapisać zmiany.");
  }

  async function show(item: Item) {
    try {
      const { url } = await openFile({ data: { id: item.id } });
      setOpen({ item, url });
      if (!item.read_at) qc.setQueryData<Item[]>(["items"], (old) => old?.map((i) => (i.id === item.id ? { ...i, read_at: new Date().toISOString() } : i)));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function remove(id: string) {
    if (!confirm("Usunąć ten plik na stałe?")) return;
    try {
      await del({ data: { id } });
      setOpen(null);
      qc.invalidateQueries({ queryKey: ["items"] });
      toast.success("Usunięto");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">
          {view === "archive" ? "Archiwum" : box === "me" ? "Moje pliki" : "Skrzynka gabinetu"}
        </h1>
        <Button variant="ghost" size="sm" onClick={() => setView(view === "new" ? "archive" : "new")}>
          {view === "new" ? <><Archive /> Archiwum</> : <><InboxIcon /> Wróć</>}
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {box === "me"
          ? "Pliki wysłane do Ciebie przez Twoje linki."
          : "Pliki bez konkretnego lekarza — obsługuje je recepcja i administrator."}
      </p>

      {hasPersonal && hasClinic && (
        <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
          {(["me", "clinic"] as const).map((b) => (
            <button
              key={b}
              onClick={() => { setBox(b); setOrg("all"); }}
              className={`flex h-10 items-center justify-center gap-2 rounded-lg text-sm font-medium ${box === b ? "bg-card shadow-soft" : "text-muted-foreground"}`}
            >
              {b === "me" ? "Dla mnie" : "Skrzynka gabinetu"}
              {unread(undefined, b) > 0 && <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{unread(undefined, b)}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-1">
        <Chip active={org === "all"} onClick={() => setOrg("all")} label="Wszystkie" count={unread()} />
        {chipOrgs.map((o) => (
          <Chip key={o.id} active={org === o.id} onClick={() => setOrg(o.id)} label={o.kind === "personal" ? "Moja praktyka" : o.name} count={unread(o.id)} />
        ))}
      </div>

      <div className="relative mt-4">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="h-11 pl-9" placeholder="Szukaj po nazwie, notatce, nadawcy" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <ul className="mt-4 divide-y overflow-hidden rounded-2xl border bg-card shadow-soft">
        {items.isLoading && <li className="p-6 text-sm text-muted-foreground">Ładowanie…</li>}
        {!items.isLoading && list.length === 0 && (
          <li className="p-10 text-center">
            <InboxIcon className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="mt-3 font-medium">{view === "new" ? "Brak nowych plików" : "Archiwum jest puste"}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {box === "me"
                ? "W „Gabinety” utwórz swój link do wysyłania i przekaż go pacjentowi, laboratorium lub recepcji."
                : "Tu trafią pliki wysłane do gabinetu przez lekarzy i linki gabinetu."}
            </p>
          </li>
        )}
        {list.map((i) => (
          <li key={i.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50">
            <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => show(i)}>
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                {i.mime_type.startsWith("image/") ? <ImageIcon className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {!i.read_at && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                  <span className={`truncate ${i.read_at ? "" : "font-semibold"}`}>{i.file_name}</span>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {orgName(i.org_id)} · {i.direction === "to_clinic" ? `Do skrzynki gabinetu · ${i.sender_name ?? ""}` : i.sender_name || "Link do wysyłania"} · {fmtSize(i.size_bytes)}
                </p>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{fmtTime(i.created_at)}</span>
            </button>
            <button
              aria-label="Oznacz jako ważne"
              className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted"
              onClick={() => update(i.id, { important: !i.important })}
            >
              <Star className={`h-4 w-4 ${i.important ? "fill-primary text-primary" : "text-muted-foreground"}`} />
            </button>
            <button
              aria-label={i.archived_at ? "Przywróć" : "Archiwizuj"}
              className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted"
              onClick={() => update(i.id, { archived_at: i.archived_at ? null : new Date().toISOString() })}
            >
              {i.archived_at ? <ArchiveRestore className="h-4 w-4 text-muted-foreground" /> : <Archive className="h-4 w-4 text-muted-foreground" />}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-center text-xs text-muted-foreground">Pliki są automatycznie usuwane po 30 dniach.</p>

      <Sheet open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        <SheetContent side="right" className="flex w-full flex-col sm:max-w-2xl">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle className="truncate pr-6">{open.item.file_name}</SheetTitle>
                <SheetDescription>
                  {orgName(open.item.org_id)} · od: {open.item.sender_name || "Link do wysyłania"} ·{" "}
                  {new Date(open.item.created_at).toLocaleString("pl-PL")}
                </SheetDescription>
              </SheetHeader>
              {open.item.note && <p className="rounded-lg bg-muted px-3 py-2 text-sm">{open.item.note}</p>}
              <div className="min-h-0 flex-1 overflow-auto rounded-xl border bg-muted">
                {open.item.mime_type.startsWith("image/") ? (
                  <img src={open.url} alt={open.item.file_name} className="mx-auto max-h-full object-contain" />
                ) : open.item.mime_type === "application/pdf" ? (
                  <iframe src={open.url} title="Podgląd PDF" className="h-full min-h-[60vh] w-full" />
                ) : (
                  <p className="p-6 text-sm text-muted-foreground">Podgląd niedostępny dla tego typu pliku. Pobierz go.</p>
                )}
              </div>
              <div className="flex gap-2">
                <Button asChild className="flex-1">
                  <a href={open.url} target="_blank" rel="noreferrer">
                    <Download /> Pobierz
                  </a>
                </Button>
                {canDelete(open.item) && (
                  <Button variant="outline" onClick={() => remove(open.item.id)}>
                    <Trash2 /> Usuń
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Chip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={`flex h-10 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition ${active ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
    >
      {label}
      {count > 0 && (
        <span className={`rounded-full px-1.5 text-xs ${active ? "bg-primary-foreground text-primary" : "bg-secondary text-secondary-foreground"}`}>
          {count}
        </span>
      )}
    </button>
  );
}
