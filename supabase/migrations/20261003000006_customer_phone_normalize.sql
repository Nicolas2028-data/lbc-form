-- 顧客の電話番号は保存時に必ず正規化する(画面から編集できるようにするため)
--  画面側で正規化し忘れても、照合キーがずれないように DB で強制する
create or replace function private.normalize_customer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.phone_normalized := nullif(public.normalize_phone(new.phone_normalized), '');
  new.name := trim(new.name);
  new.furigana := nullif(trim(coalesce(new.furigana, '')), '');
  new.email := nullif(lower(trim(coalesce(new.email, ''))), '');
  return new;
end;
$$;

create trigger customers_normalize before insert or update on public.customers
  for each row execute function private.normalize_customer();
