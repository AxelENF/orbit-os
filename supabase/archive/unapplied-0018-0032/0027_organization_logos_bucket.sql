-- 0018_organization_logos_bucket.sql
insert into storage.buckets (id, name, public)
values ('organization-logos', 'organization-logos', false)
on conflict (id) do nothing;

create policy "Organization members read organization logos" on storage.objects
  for select to authenticated using (
    bucket_id = 'organization-logos'
    and public.is_organization_member((storage.foldername(name))[1]::uuid)
  );

create policy "Organization owners upload organization logos" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'organization-logos'
    and public.has_organization_role((storage.foldername(name))[1]::uuid, array['owner']::public.organization_role[])
    and name = (storage.foldername(name))[1] || '/logo.png'
  );

create policy "Organization owners replace organization logos" on storage.objects
  for update to authenticated using (
    bucket_id = 'organization-logos'
    and public.has_organization_role((storage.foldername(name))[1]::uuid, array['owner']::public.organization_role[])
  ) with check (
    bucket_id = 'organization-logos'
    and public.has_organization_role((storage.foldername(name))[1]::uuid, array['owner']::public.organization_role[])
    and name = (storage.foldername(name))[1] || '/logo.png'
  );
