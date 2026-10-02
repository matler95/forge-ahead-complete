import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getFileUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: item } = await context.supabase
      .from("items")
      .select("id, org_id, storage_path, read_at, file_name")
      .eq("id", data.id)
      .maybeSingle();
    if (!item) throw new Error("Brak dostępu do pliku.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: signed, error } = await supabaseAdmin.storage
      .from("files")
      .createSignedUrl(item.storage_path, 60);
    if (error || !signed) throw new Error("Nie udało się otworzyć pliku.");
    if (!item.read_at) await context.supabase.from("items").update({ read_at: new Date().toISOString() }).eq("id", item.id);
    await supabaseAdmin.from("audit_log").insert({
      org_id: item.org_id,
      actor_user_id: context.userId,
      action: "item.open",
      target: item.id,
    });
    return { url: signed.signedUrl };
  });

export const deleteItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: item } = await context.supabase
      .from("items")
      .select("id, org_id, storage_path")
      .eq("id", data.id)
      .maybeSingle();
    if (!item) throw new Error("Brak dostępu.");
    const { error } = await context.supabase.from("items").delete().eq("id", item.id);
    if (error) throw new Error("Nie można usunąć tego pliku.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.storage.from("files").remove([item.storage_path]);
    await supabaseAdmin.from("audit_log").insert({
      org_id: item.org_id,
      actor_user_id: context.userId,
      action: "item.delete",
      target: item.id,
    });
    return { ok: true };
  });

export const createDropLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        orgId: z.string().uuid(),
        forMe: z.boolean(),
        label: z.string().trim().min(1).max(80),
        expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { newToken, hashToken } = await import("./tokens.server");
    const token = newToken();
    const { error } = await context.supabase.from("drop_links").insert({
      org_id: data.orgId,
      recipient_user_id: data.forMe ? context.userId : null,
      label: data.label,
      token_hash: await hashToken(token),
      created_by: context.userId,
      expires_at: data.expiresInDays
        ? new Date(Date.now() + data.expiresInDays * 86400000).toISOString()
        : null,
    });
    if (error) throw new Error("Twoja rola nie pozwala tworzyć tego linku. Linki tworzą lekarze (dla siebie) i administrator.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("audit_log").insert({
      org_id: data.orgId,
      actor_user_id: context.userId,
      action: "link.create",
      target: data.label,
    });
    return { token };
  });

export const renewDropLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: old } = await context.supabase.from("drop_links").select("*").eq("id", data.id).maybeSingle();
    if (!old) throw new Error("Brak dostępu.");
    await context.supabase.from("drop_links").update({ revoked_at: new Date().toISOString() }).eq("id", old.id);
    const { newToken, hashToken } = await import("./tokens.server");
    const token = newToken();
    const { error } = await context.supabase.from("drop_links").insert({
      org_id: old.org_id,
      recipient_user_id: old.recipient_user_id,
      label: old.label,
      token_hash: await hashToken(token),
      created_by: context.userId,
      expires_at: old.expires_at,
      max_uses: old.max_uses,
    });
    if (error) throw new Error("Nie udało się odnowić linku.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("audit_log").insert({
      org_id: old.org_id,
      actor_user_id: context.userId,
      action: "link.renew",
      target: old.label,
    });
    return { token };
  });

export const revokeDropLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("drop_links")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id)
      .select("org_id, label")
      .maybeSingle();
    if (error || !row) throw new Error("Brak dostępu.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("audit_log").insert({
      org_id: row.org_id,
      actor_user_id: context.userId,
      action: "link.revoke",
      target: row.label,
    });
    return { ok: true };
  });

export const addMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        orgId: z.string().uuid(),
        email: z.string().trim().email().max(255),
        role: z.enum(["admin", "doctor", "staff"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_org_role", {
      _org: data.orgId,
      _uid: context.userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Tylko administrator gabinetu może dodawać członków.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Already a member?
    const { data: profile } = await supabaseAdmin.from("profiles").select("id").ilike("email", data.email).maybeSingle();
    if (profile) {
      const { data: existing } = await supabaseAdmin
        .from("memberships")
        .select("id")
        .eq("org_id", data.orgId)
        .eq("user_id", profile.id)
        .maybeSingle();
      if (existing) throw new Error("Ta osoba jest już członkiem gabinetu.");
    }
    // Nobody is added without consent: create a pending invitation the person accepts in the app.
    const { error } = await supabaseAdmin.from("invitations").insert({
      org_id: data.orgId,
      email: data.email.toLowerCase(),
      role: data.role,
      invited_by: context.userId,
    });
    if (error) throw new Error("Zaproszenie dla tego adresu już czeka na odpowiedź.");
    // DUMMY: invitation e-mail placeholder (Resend/Brevo) — no file names / patient data
    console.log("[dummy-invite-email]", data.email);
    await supabaseAdmin.from("audit_log").insert({
      org_id: data.orgId,
      actor_user_id: context.userId,
      action: "invite.send",
      target: data.email,
    });
    return { status: "invited" as const, hasAccount: !!profile };
  });

export const removeMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ membershipId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("memberships")
      .delete()
      .eq("id", data.membershipId)
      .select("org_id, user_id")
      .maybeSingle();
    if (error || !row) throw new Error("Nie można odebrać dostępu.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Revoke this person's links in the clinic immediately (UC5)
    await supabaseAdmin
      .from("drop_links")
      .update({ revoked_at: new Date().toISOString() })
      .eq("org_id", row.org_id)
      .eq("recipient_user_id", row.user_id)
      .is("revoked_at", null);
    await supabaseAdmin.from("audit_log").insert({
      org_id: row.org_id,
      actor_user_id: context.userId,
      action: "member.revoke",
      target: row.user_id,
    });
    return { ok: true };
  });

const sendMeta = z.object({
  orgId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
  mime: z.string().max(120),
});

export const sendToClinicInit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => sendMeta.parse(d))
  .handler(async ({ data, context }) => {
    const { data: ok } = await context.supabase.rpc("is_member", { _org: data.orgId, _uid: context.userId });
    if (!ok) throw new Error("Nie jesteś członkiem tego gabinetu.");
    const { MAX_BYTES } = await import("./tokens.server");
    if (data.size > MAX_BYTES) throw new Error("Plik jest za duży (maks. 50 MB).");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const path = `${data.orgId}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
    const { data: up, error } = await supabaseAdmin.storage.from("files").createSignedUploadUrl(path);
    if (error || !up) throw new Error("Nie udało się rozpocząć wysyłania.");
    return { path: up.path, uploadToken: up.token };
  });

export const sendToClinicComplete = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    sendMeta.extend({ path: z.string().max(200), note: z.string().trim().max(500).optional().default("") }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: ok } = await context.supabase.rpc("is_member", { _org: data.orgId, _uid: context.userId });
    if (!ok || !data.path.startsWith(`${data.orgId}/`)) throw new Error("Brak dostępu.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: prof } = await supabaseAdmin.from("profiles").select("display_name").eq("id", context.userId).maybeSingle();
    const { error } = await supabaseAdmin.from("items").insert({
      org_id: data.orgId,
      recipient_user_id: null,
      direction: "to_clinic",
      file_name: data.fileName,
      storage_path: data.path,
      size_bytes: data.size,
      mime_type: data.mime || "application/octet-stream",
      sender_name: prof?.display_name ?? "Lekarz",
      note: data.note || null,
    });
    if (error) throw new Error("Nie udało się zapisać pliku.");
    await supabaseAdmin.from("audit_log").insert({
      org_id: data.orgId,
      actor_user_id: context.userId,
      action: "item.send_to_clinic",
      target: data.fileName,
    });
    return { ok: true };
  });
