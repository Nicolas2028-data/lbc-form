-- LBC Care の初期データ(店舗・メニュー・商品)。テスト環境・本番環境の作成時に 1 回だけ実行する
-- スタッフはダッシュボードでユーザー作成後、staff テーブルに追加する(README 参照)
insert into public.stores (id, name, timezone, address)
values ('00000000-0000-4000-8000-000000000001', 'LBC Care', 'Asia/Tokyo', '三重県四日市市')
on conflict (id) do nothing;

insert into public.menus (store_id, code, name, duration_min, price, sort) values
  ('00000000-0000-4000-8000-000000000001', 'chiro',
   '{"ja":"カイロプラクティック","pt":"Quiropraxia","es":"Quiropráctica"}', 60, 4000, 10),
  ('00000000-0000-4000-8000-000000000001', 'fascia',
   '{"ja":"筋膜リリース","pt":"Liberação miofascial","es":"Liberación miofascial"}', 60, 5000, 20),
  ('00000000-0000-4000-8000-000000000001', 'cupping',
   '{"ja":"吸い玉（カッピング）","pt":"Ventosaterapia","es":"Ventosaterapia"}', 60, 4000, 30),
  ('00000000-0000-4000-8000-000000000001', 'total',
   '{"ja":"トータルケア","pt":"Cuidado total","es":"Cuidado total"}', 60, 6000, 40)
on conflict (store_id, code) do nothing;

insert into public.products (store_id, code, kind, name, price, uses, validity) values
  ('00000000-0000-4000-8000-000000000001', 'monthly2', 'ticket',
   '{"ja":"月2回プラン","pt":"Plano 2x por mês","es":"Plan 2 veces al mes"}', 10000, 2, 'end_of_month')
on conflict (store_id, code) do nothing;
