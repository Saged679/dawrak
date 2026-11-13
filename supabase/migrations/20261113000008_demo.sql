-- Demo mode: two fictional demo tenants (dental clinic + women's salon).
-- seed_demo() is the single source of the demo data; seed.sql (local) and reset_demo() (daily cron
-- on the hosted project) both call it, so there is no drift between the two.
-- All names, phone numbers and e-mails are fictional.
--
-- Demo auth users have fixed ids (see supabase/seed.sql). seed_demo() links them through
-- memberships / providers.user_id only if they already exist in auth.users.

create or replace function public.seed_demo()
returns void
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_clinic uuid := 'd0000000-0000-4000-8000-000000000001';
  v_salon  uuid := 'd0000000-0000-4000-8000-000000000002';
  t        record;
  pr       record;
  v_times  time[];
  v_svc    public.services;
  v_svc_id uuid;
  v_cnt    int;
  v_cust   uuid;
  v_start  timestamptz;
  v_status text;
  v_appt   uuid;
  v_price  numeric;
  d        int;
  i        int;
begin
  if exists (select 1 from public.tenants where id in (v_clinic, v_salon)) then
    return; -- already seeded; reset_demo() deletes first
  end if;

  insert into public.tenants (id, slug, name_ar, name_en, kind, deposit_enabled, deposit_type, deposit_value, brand_color, is_demo) values
    (v_clinic, 'demo-clinic', 'عيادة نبض لطب الأسنان', 'Nabd Dental Clinic', 'clinic', true,  'fixed', 50, '#0f766e', true),
    (v_salon,  'demo-salon',  'صالون لمسة للسيدات',    'Lamsa Ladies Salon', 'salon',  false, 'fixed', 0,  '#be185d', true);

  -- ---- services (SAR) ----
  insert into public.services (id, tenant_id, name_ar, name_en, description_ar, duration_min, buffer_min, price) values
    ('e1000000-0000-4000-8000-000000000001', v_clinic, 'كشف وفحص',            'Check-up & Exam',        'فحص شامل للأسنان مع التشخيص',            30, 10, 150),
    ('e1000000-0000-4000-8000-000000000002', v_clinic, 'تنظيف الأسنان',       'Teeth Cleaning',         'إزالة الجير والتلميع',                    45, 10, 300),
    ('e1000000-0000-4000-8000-000000000003', v_clinic, 'حشو تجميلي',          'Cosmetic Filling',       'حشوة بلون السن الطبيعي',                  60, 10, 450),
    ('e1000000-0000-4000-8000-000000000004', v_clinic, 'تبييض الأسنان',       'Teeth Whitening',        'جلسة تبييض بالليزر',                      60, 10, 900),
    ('e1000000-0000-4000-8000-000000000005', v_clinic, 'علاج قناة الجذر',     'Root Canal Treatment',   'علاج العصب تحت التخدير الموضعي',          90, 10, 1200),
    ('e1000000-0000-4000-8000-000000000006', v_clinic, 'استشارة تقويم',       'Orthodontic Consultation','تقييم الحالة وخطة العلاج',                30, 10, 200),
    ('e2000000-0000-4000-8000-000000000001', v_salon,  'قص وتصفيف',           'Cut & Style',            'قص حسب الطلب مع سشوار',                   45, 10, 120),
    ('e2000000-0000-4000-8000-000000000002', v_salon,  'صبغة شعر',            'Hair Colour',            'صبغة كاملة مع العناية',                   120, 10, 450),
    ('e2000000-0000-4000-8000-000000000003', v_salon,  'علاج كيراتين',        'Keratin Treatment',      'علاج لفرد الشعر وتنعيمه',                 150, 10, 800),
    ('e2000000-0000-4000-8000-000000000004', v_salon,  'مكياج سهرة',          'Evening Makeup',         'مكياج كامل للمناسبات',                    60, 10, 350),
    ('e2000000-0000-4000-8000-000000000005', v_salon,  'مانيكير وباديكير',    'Manicure & Pedicure',    'عناية كاملة بالأظافر',                    75, 10, 180),
    ('e2000000-0000-4000-8000-000000000006', v_salon,  'حمام مغربي',          'Moroccan Bath',          'جلسة استرخاء وتنظيف للبشرة',              60, 10, 250);

  -- ---- providers (user_id links to demo auth users when present) ----
  insert into public.providers (id, tenant_id, user_id, name_ar, name_en, title_ar, title_en) values
    ('f1000000-0000-4000-8000-000000000001', v_clinic, (select id from auth.users where id = 'a0000000-0000-4000-8000-000000000003'),
       'د. سلمى الحارثي', 'Dr. Salma Al-Harithi', 'استشارية طب الأسنان العام', 'General Dentistry Consultant'),
    ('f1000000-0000-4000-8000-000000000002', v_clinic, null, 'د. ماجد الدوسري', 'Dr. Majed Al-Dosari', 'أخصائي علاج الجذور', 'Endodontist'),
    ('f1000000-0000-4000-8000-000000000003', v_clinic, null, 'د. نورة العتيبي', 'Dr. Noura Al-Otaibi', 'أخصائية تقويم الأسنان', 'Orthodontist'),
    ('f2000000-0000-4000-8000-000000000001', v_salon,  (select id from auth.users where id = 'a0000000-0000-4000-8000-000000000006'),
       'ليان المطيري', 'Layan Al-Mutairi', 'مصففة شعر رئيسية', 'Senior Hair Stylist'),
    ('f2000000-0000-4000-8000-000000000002', v_salon,  null, 'هيفاء الشمري', 'Haifa Al-Shammari', 'خبيرة مكياج', 'Makeup Artist'),
    ('f2000000-0000-4000-8000-000000000003', v_salon,  null, 'دانة الزهراني', 'Dana Al-Zahrani', 'أخصائية عناية', 'Spa & Nails Specialist');

  insert into public.provider_services (tenant_id, provider_id, service_id)
  select case when p like 'f1%' then v_clinic else v_salon end, p::uuid, s::uuid
  from (values
    ('f1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001'),
    ('f1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002'),
    ('f1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000003'),
    ('f1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000004'),
    ('f1000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001'),
    ('f1000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000003'),
    ('f1000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000005'),
    ('f1000000-0000-4000-8000-000000000003','e1000000-0000-4000-8000-000000000001'),
    ('f1000000-0000-4000-8000-000000000003','e1000000-0000-4000-8000-000000000006'),
    ('f2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001'),
    ('f2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000002'),
    ('f2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000003'),
    ('f2000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001'),
    ('f2000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000004'),
    ('f2000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000005'),
    ('f2000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000006')
  ) v(p, s);

  -- ---- working hours (0 = Sunday) ----
  -- Clinic: Sun-Thu split shift; doctor 3 afternoons only. Salon: Sat-Thu 10:00-22:00 (stylist 3 from 14:00).
  insert into public.working_hours (tenant_id, provider_id, weekday, start_time, end_time)
  select v_clinic, p.id, w, s, e
  from public.providers p
  cross join generate_series(0, 4) w
  cross join (values ('09:00'::time, '13:00'::time), ('16:00'::time, '21:00'::time)) sh(s, e)
  where p.tenant_id = v_clinic and not (p.id = 'f1000000-0000-4000-8000-000000000003' and s = '09:00'::time);

  insert into public.working_hours (tenant_id, provider_id, weekday, start_time, end_time)
  select v_salon, p.id, w, case when p.id = 'f2000000-0000-4000-8000-000000000003' then '14:00'::time else '10:00'::time end, '22:00'::time
  from public.providers p
  cross join (values (0),(1),(2),(3),(4),(6)) x(w)
  where p.tenant_id = v_salon;

  -- one upcoming day off so availability visibly differs
  insert into public.time_off (tenant_id, provider_id, starts_at, ends_at, reason)
  values (v_clinic, 'f1000000-0000-4000-8000-000000000002',
          ((current_date + 10) + time '00:00') at time zone 'Asia/Riyadh',
          ((current_date + 11) + time '00:00') at time zone 'Asia/Riyadh', 'إجازة / Leave');

  -- ---- customers (fictional) ----
  insert into public.customers (tenant_id, full_name, phone, email, locale)
  select v_clinic, n, '05000010' || lpad(idx::text, 2, '0'), 'patient' || idx || '@example.com', 'ar'
  from unnest(array['فهد الراشد','منال السبيعي','عبدالله القرني','هند الغامدي','تركي العنزي',
                    'أمل الشهري','سعود البقمي','لجين الحربي','ياسر المالكي','جود الخالدي']) with ordinality as u(n, idx);
  insert into public.customers (tenant_id, full_name, phone, email, locale)
  select v_salon, n, '05000020' || lpad(idx::text, 2, '0'), 'client' || idx || '@example.com', 'ar'
  from unnest(array['شهد الدوسري','رهف الجهني','غدير العمري','أريج السلمي','ملاك الشريف',
                    'رزان البلوي','عهود القحطاني','لمى الأحمدي','سديم الفيفي','تالا العسيري']) with ordinality as u(n, idx);

  -- ---- appointments: today-7 .. today+7 (only slots that are valid per working hours / services) ----
  for t in select id, timezone, kind, deposit_enabled, deposit_value from public.tenants where id in (v_clinic, v_salon) loop
    v_times := case when t.kind = 'clinic'
                    then array['09:30','11:30','17:00','19:00']::time[]
                    else array['10:00','13:00','16:00','19:00']::time[] end;
    for pr in select p.id as pid, (row_number() over (order by p.id))::int as rn
              from public.providers p where p.tenant_id = t.id loop
      select count(*) into v_cnt from public.provider_services where provider_id = pr.pid;
      for d in -7..7 loop
        for i in 1..array_length(v_times, 1) loop
          v_start := ((current_date + d) + v_times[i]) at time zone t.timezone;
          select ps.service_id into v_svc_id from public.provider_services ps
            where ps.provider_id = pr.pid order by ps.service_id
            offset ((d + 7) * 4 + i + pr.rn) % v_cnt limit 1;
          select * into v_svc from public.services where id = v_svc_id;
          continue when not public._slot_is_free(t.id, pr.pid, v_start, v_svc.duration_min, v_svc.buffer_min);

          select id into v_cust from public.customers where tenant_id = t.id
            order by phone offset ((d + 7) * 7 + i * 3 + pr.rn) % 10 limit 1;

          if v_start < now() then
            v_status := case when (d + i + pr.rn) % 9 = 0 then 'cancelled'
                              when (d + i + pr.rn) % 7 = 0 then 'no_show'
                              else 'completed' end;
          else
            v_status := case when (d + i + pr.rn) % 11 = 0 then 'cancelled' else 'confirmed' end;
          end if;

          insert into public.appointments (tenant_id, provider_id, service_id, customer_id, starts_at, ends_at, status, source, price)
          values (t.id, pr.pid, v_svc.id, v_cust, v_start, v_start + make_interval(mins => v_svc.duration_min),
                  v_status, (array['web','chat','staff'])[1 + i % 3], v_svc.price)
          returning id into v_appt;

          -- revenue: completed = full price paid; future confirmed in a deposit tenant = deposit paid
          v_price := case when v_status = 'completed' then v_svc.price
                          when v_status = 'confirmed' and t.deposit_enabled then least(t.deposit_value, v_svc.price)
                          else null end;
          if v_price is not null then
            insert into public.payments (tenant_id, appointment_id, amount, status, provider, provider_ref)
            values (t.id, v_appt, v_price, 'paid', 'moyasar', 'demo_' || v_appt);
          end if;

          if v_status = 'confirmed' then
            insert into public.reminders (tenant_id, appointment_id, kind, send_at, status)
            select t.id, v_appt, k.kind, v_start - k.lead,
                   case when v_start - k.lead > now() then 'pending' else 'skipped' end
            from (values ('24h', interval '24 hours'), ('2h', interval '2 hours')) k(kind, lead);
          end if;
        end loop;
      end loop;
    end loop;
  end loop;

  -- ---- knowledge base (embeddings are filled by the app's ingestion step) ----
  insert into public.kb_documents (id, tenant_id, title, source_type, content) values
    ('ab000000-0000-4000-8000-000000000001', v_clinic, 'الأسئلة الشائعة', 'faq', 'أسئلة شائعة عن العيادة'),
    ('ab000000-0000-4000-8000-000000000002', v_salon,  'الأسئلة الشائعة', 'faq', 'أسئلة شائعة عن الصالون');
  insert into public.kb_chunks (tenant_id, document_id, chunk_index, content) values
    (v_clinic, 'ab000000-0000-4000-8000-000000000001', 0, 'ساعات العمل: من الأحد إلى الخميس، من 9 صباحاً إلى 1 ظهراً ومن 4 عصراً إلى 9 مساءً. الجمعة والسبت إجازة.'),
    (v_clinic, 'ab000000-0000-4000-8000-000000000001', 1, 'العربون 50 ريال يُخصم من قيمة الخدمة، ويُلغى الحجز تلقائياً إذا لم يتم الدفع خلال 15 دقيقة.'),
    (v_clinic, 'ab000000-0000-4000-8000-000000000001', 2, 'نقبل التأمين الطبي من عدة شركات، يرجى إحضار البطاقة عند الحضور.'),
    (v_salon,  'ab000000-0000-4000-8000-000000000002', 0, 'ساعات العمل: من السبت إلى الخميس من 10 صباحاً حتى 10 مساءً، والجمعة إجازة.'),
    (v_salon,  'ab000000-0000-4000-8000-000000000002', 1, 'يمكن إلغاء الحجز أو تأجيله قبل الموعد بساعتين على الأقل.'),
    (v_salon,  'ab000000-0000-4000-8000-000000000002', 2, 'نوفر باقات للعروس تشمل المكياج والشعر والعناية بالأظافر، اسألي عن العروض الحالية.');

  -- ---- conversations ----
  insert into public.conversations (id, tenant_id, customer_id, channel, external_id, started_at, last_message_at)
  select v.id::uuid, v.tid, (select c.id from public.customers c where c.tenant_id = v.tid and c.phone = v.phone),
         'web', 'demo-session-' || right(v.id, 4), now() - v.ago, now() - v.ago
  from (values
    ('cc000000-0000-4000-8000-000000000001', v_clinic, '0500001001', interval '1 day'),
    ('cc000000-0000-4000-8000-000000000002', v_clinic, '0500001002', interval '3 hours'),
    ('cc000000-0000-4000-8000-000000000003', v_clinic, '0500001003', interval '2 days'),
    ('cc000000-0000-4000-8000-000000000011', v_salon,  '0500002001', interval '1 day'),
    ('cc000000-0000-4000-8000-000000000012', v_salon,  '0500002002', interval '5 hours'),
    ('cc000000-0000-4000-8000-000000000013', v_salon,  '0500002003', interval '2 days')
  ) v(id, tid, phone, ago);

  insert into public.messages (tenant_id, conversation_id, role, content, created_at)
  select c.tenant_id, c.id, m.role, m.content, c.started_at + (m.seq * interval '40 seconds')
  from (values
    ('cc000000-0000-4000-8000-000000000001', 1, 'user',      'السلام عليكم، أبغى أحجز موعد تنظيف أسنان'),
    ('cc000000-0000-4000-8000-000000000001', 2, 'assistant', 'وعليكم السلام ورحمة الله. تنظيف الأسنان مدته 45 دقيقة وسعره 300 ريال. أي يوم يناسبك؟'),
    ('cc000000-0000-4000-8000-000000000001', 3, 'user',      'الأحد القادم مساءً'),
    ('cc000000-0000-4000-8000-000000000001', 4, 'assistant', 'متاح الأحد الساعة 5:00 م و7:00 م مع د. سلمى الحارثي. أيهما تفضل؟'),
    ('cc000000-0000-4000-8000-000000000001', 5, 'user',      '5 مساءً'),
    ('cc000000-0000-4000-8000-000000000001', 6, 'assistant', 'تم تجهيز الحجز. يرجى دفع العربون 50 ريال خلال 15 دقيقة لتأكيده.'),
    ('cc000000-0000-4000-8000-000000000002', 1, 'user',      'كم سعر تبييض الأسنان؟'),
    ('cc000000-0000-4000-8000-000000000002', 2, 'assistant', 'جلسة تبييض الأسنان بالليزر 900 ريال وتستغرق ساعة تقريباً. تحب أشوف لك أقرب موعد؟'),
    ('cc000000-0000-4000-8000-000000000003', 1, 'user',      'هل تقبلون التأمين الطبي؟'),
    ('cc000000-0000-4000-8000-000000000003', 2, 'assistant', 'نعم، نقبل التأمين من عدة شركات. يرجى إحضار البطاقة عند الحضور.'),
    ('cc000000-0000-4000-8000-000000000011', 1, 'user',      'مرحباً، أبغى مكياج سهرة يوم الخميس'),
    ('cc000000-0000-4000-8000-000000000011', 2, 'assistant', 'أهلاً بك. مكياج السهرة مدته ساعة وسعره 350 ريال مع هيفاء الشمري. أي وقت يناسبك الخميس؟'),
    ('cc000000-0000-4000-8000-000000000011', 3, 'user',      'الساعة 6 مساءً'),
    ('cc000000-0000-4000-8000-000000000011', 4, 'assistant', 'تم تأكيد حجزك الخميس الساعة 6:00 م مع هيفاء. نذكرك قبل الموعد بيوم.'),
    ('cc000000-0000-4000-8000-000000000012', 1, 'user',      'عندكم عروض للعروس؟'),
    ('cc000000-0000-4000-8000-000000000012', 2, 'assistant', 'نوفر باقات للعروس تشمل المكياج والشعر والأظافر. تحبين أحجز لك موعد استشارة؟'),
    ('cc000000-0000-4000-8000-000000000013', 1, 'user',      'أبغى أأجل موعدي لبكرة'),
    ('cc000000-0000-4000-8000-000000000013', 2, 'assistant', 'أكيد، تقدرين تأجلين من صفحة مواعيدي عبر الرابط المرسل لك، أو أساعدك هنا. أي وقت تفضلين بكرة؟')
  ) m(conv, seq, role, content)
  join public.conversations c on c.id = m.conv::uuid;

  -- ---- demo memberships (only for demo auth users that exist) ----
  insert into public.memberships (user_id, tenant_id, role)
  select u.id, v.tid, v.role
  from (values
    ('a0000000-0000-4000-8000-000000000001', v_clinic, 'owner'),
    ('a0000000-0000-4000-8000-000000000002', v_clinic, 'receptionist'),
    ('a0000000-0000-4000-8000-000000000003', v_clinic, 'provider'),
    ('a0000000-0000-4000-8000-000000000004', v_salon,  'owner'),
    ('a0000000-0000-4000-8000-000000000005', v_salon,  'receptionist'),
    ('a0000000-0000-4000-8000-000000000006', v_salon,  'provider')
  ) v(uid, tid, role)
  join auth.users u on u.id = v.uid::uuid;
end $$;

-- Wipes every demo tenant (all tenant data cascades) and re-seeds. Demo auth users are kept.
create or replace function public.reset_demo()
returns void
language plpgsql volatile security definer
set search_path = public, extensions
as $$
begin
  delete from public.tenants where is_demo;   -- ON DELETE CASCADE removes all tenant rows
  perform public.seed_demo();
end $$;
