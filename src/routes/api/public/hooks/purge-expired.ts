import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

// Retention (G3): files older than their expires_at are deleted from storage and DB.
export const Route = createFileRoute("/api/public/hooks/purge-expired")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: rows, error } = await supabaseAdmin
          .from("items")
          .select("id, org_id, storage_path")
          .lte("expires_at", new Date().toISOString())
          .limit(500);
        if (error) return new Response("error", { status: 500 });
        if (rows.length) {
          await supabaseAdmin.storage.from("files").remove(rows.map((r) => r.storage_path));
          await supabaseAdmin.from("items").delete().in("id", rows.map((r) => r.id));
          await supabaseAdmin.from("audit_log").insert(
            rows.map((r) => ({ org_id: r.org_id, action: "item.expire", target: r.id, actor_label: "system" })),
          );
        }
        return Response.json({ purged: rows.length });
      },
    },
  },
});
