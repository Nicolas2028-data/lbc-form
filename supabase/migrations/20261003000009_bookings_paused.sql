-- 予約機能の一時停止(2026-10-03 Nicolas の判断で画面を非表示)
--  テーブル・関数・データは残し、お客様(未ログイン)から予約関連の関数を呼べないようにする。
--  画面がないとスタッフが予約に気づけないため、外部から予約を作られる経路を閉じておく。
--  再開するときは、この revoke を grant に戻す migration を追加する
revoke execute on function public.get_available_slots(uuid, uuid, date, date, uuid) from anon;
revoke execute on function public.create_booking(jsonb) from anon;
revoke execute on function public.get_booking_by_token(uuid) from anon;
revoke execute on function public.cancel_booking(jsonb) from anon;
