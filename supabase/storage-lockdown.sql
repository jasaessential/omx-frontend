-- ═══════════════════════════════════════════════════════════════════
-- JASA V2 — lock down the Supabase "files" bucket (audit SEC-02)
-- Run in Supabase Dashboard → SQL Editor, AFTER the server with
-- routes/files.js is live (uploads/views then use the service-role key,
-- which bypasses RLS, so no storage.objects policy is needed at all).
-- ═══════════════════════════════════════════════════════════════════

-- 1. Private bucket: /object/public/files/... stops working; only signed URLs do.
--    50 MB matches the xerox upload limit in xerox-order.js.
update storage.buckets
   set public = false,
       file_size_limit = 52428800
 where id = 'files';

-- 2. Review what anon / public / authenticated may do on storage.objects today
select policyname, cmd, roles, qual, with_check
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects';

-- 3. Drop every storage.objects policy that lets browsers (anon key or
--    Supabase-auth users — this app never signs users into Supabase) list,
--    read, upload or delete. Check step 2 first if other buckets exist.
do $$
declare r record;
begin
  for r in
    select policyname from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and (roles && array['anon', 'public', 'authenticated']::name[])
  loop
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end $$;

-- 4. Verify: should return no rows for the anon / public / authenticated roles
select policyname, roles from pg_policies
 where schemaname = 'storage' and tablename = 'objects';
select id, public, file_size_limit from storage.buckets where id = 'files';
