DROP POLICY IF EXISTS "links insert" ON public.drop_links;
CREATE POLICY "links insert" ON public.drop_links FOR INSERT TO authenticated
WITH CHECK (
  created_by = auth.uid()
  AND public.is_member(org_id, auth.uid())
  AND (
    public.has_org_role(org_id, auth.uid(), 'admin')
    OR (recipient_user_id = auth.uid() AND public.has_org_role(org_id, auth.uid(), 'doctor'))
  )
);