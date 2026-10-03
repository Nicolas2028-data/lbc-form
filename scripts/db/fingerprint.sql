-- スキーマの指紋(関数本体・列・RLS ポリシー・権限の md5)。
-- ローカル(マイグレーションを全部流した PGlite)とテスト/本番環境で同じ結果になれば、
-- リポジトリと DB の中身が一致している(手作業の変更・適用漏れがない)
select jsonb_build_object(
  'functions', (select jsonb_object_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                                        md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')))
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')),
  'columns', (select jsonb_object_agg(table_schema || '.' || table_name, cols) from (
                select table_schema, table_name,
                       md5(string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' order by column_name)) cols
                from information_schema.columns where table_schema in ('public', 'private') group by 1, 2) c),
  'policies', (select jsonb_object_agg(tablename || '.' || policyname,
                                       md5(coalesce(qual, '') || '|' || coalesce(with_check, '') || '|' || cmd || '|' || array_to_string(roles, ',')))
               from pg_policies where schemaname = 'public'),
  'rls', (select jsonb_object_agg(tablename, rowsecurity) from pg_tables where schemaname = 'public'),
  'grants', (select md5(string_agg(grantee || ':' || table_name || ':' || privilege_type, ',' order by grantee, table_name, privilege_type))
             from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')),
  'fn_grants', (select md5(string_agg(r.rolname || ':' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ',' order by r.rolname, p.proname))
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace, pg_roles r
                where n.nspname = 'public' and r.rolname in ('anon', 'authenticated') and has_function_privilege(r.oid, p.oid, 'execute'))
) as fp;
