-- FieldCred — optional demo seed data.
-- Run this AFTER schema.sql, only in a project you want demo data in (e.g.
-- local testing or a sales demo tenant). Real tenant projects should skip
-- this file entirely — see supabase/PROVISIONING.md.
-- Safe to re-run: public_slug is unique, so duplicates are skipped.

insert into public.workers (name, title, department, location, phone, email, skills, certifications, public_slug)
values
  ('Marcus Reyes', 'Journeyman Electrician', 'Electrical', 'Houston, TX', '(555) 012-8841', 'm.reyes@fieldcred.co',
   '["Conduit bending","Motor controls","PLC wiring","Blueprint reading","Troubleshooting"]',
   '[
      {"id":"c1","name":"Journeyman Electrician License","issuer":"Texas Dept. of Licensing & Regulation","badgeImageUrl":null,"earnedDate":"2022-03-14","expiryDate":"2029-03-14","verificationUrl":"https://verify.tdlr.texas.gov/mreyes"},
      {"id":"c2","name":"OSHA 30-Hour Construction","issuer":"U.S. OSHA","badgeImageUrl":null,"earnedDate":"2023-06-02","expiryDate":"2028-06-02","verificationUrl":"https://osha.gov/verify/mreyes"},
      {"id":"c3","name":"Confined Space Entry","issuer":"NCCER","badgeImageUrl":null,"earnedDate":"2024-02-10","expiryDate":"2027-02-10","verificationUrl":"https://nccer.org/verify/mreyes"},
      {"id":"c4","name":"NFPA 70E Arc Flash Safety","issuer":"NFPA","badgeImageUrl":null,"earnedDate":"2024-08-01","expiryDate":"2026-08-15","verificationUrl":"https://nfpa.org/verify/mreyes"},
      {"id":"c5","name":"First Aid / CPR","issuer":"American Red Cross","badgeImageUrl":null,"earnedDate":"2023-08-01","expiryDate":"2026-06-01","verificationUrl":"https://redcross.org/verify/mreyes"}
    ]', 'mreyes-demo1'),
  ('Dana Whitfield', 'Certified Welder', 'Fabrication', 'Odessa, TX', '(555) 019-3302', 'd.whitfield@fieldcred.co',
   '["MIG welding","TIG welding","Blueprint reading","Pipe fit-up"]',
   '[
      {"id":"c1","name":"AWS D1.1 Structural Welding","issuer":"American Welding Society","badgeImageUrl":null,"earnedDate":"2023-01-10","expiryDate":"2028-01-10","verificationUrl":"https://aws.org/verify/dwhitfield"},
      {"id":"c2","name":"OSHA 10-Hour Construction","issuer":"U.S. OSHA","badgeImageUrl":null,"earnedDate":"2022-05-01","expiryDate":"2027-05-01","verificationUrl":"https://osha.gov/verify/dwhitfield"},
      {"id":"c3","name":"Confined Space Entry","issuer":"NCCER","badgeImageUrl":null,"earnedDate":"2024-03-01","expiryDate":"2027-03-01","verificationUrl":"https://nccer.org/verify/dwhitfield"},
      {"id":"c4","name":"Rigging & Signaling","issuer":"NCCER","badgeImageUrl":null,"earnedDate":"2023-09-01","expiryDate":"2026-08-20","verificationUrl":"https://nccer.org/verify/dwhitfield-rig"}
    ]', 'dwhitfield-demo2'),
  ('Luis Ferrer', 'HVAC Technician', 'Mechanical', 'San Antonio, TX', '(555) 044-1187', 'l.ferrer@fieldcred.co',
   '["Refrigerant handling","Duct design","Controls troubleshooting"]',
   '[
      {"id":"c1","name":"EPA 608 Universal","issuer":"U.S. EPA","badgeImageUrl":null,"earnedDate":"2021-04-01","expiryDate":"2031-04-01","verificationUrl":"https://epa.gov/verify/lferrer"},
      {"id":"c2","name":"HVAC Excellence Certification","issuer":"HVAC Excellence","badgeImageUrl":null,"earnedDate":"2022-06-01","expiryDate":"2027-06-01","verificationUrl":"https://hvacexcellence.org/verify/lferrer"},
      {"id":"c3","name":"OSHA 10-Hour Construction","issuer":"U.S. OSHA","badgeImageUrl":null,"earnedDate":"2023-01-01","expiryDate":"2028-01-01","verificationUrl":"https://osha.gov/verify/lferrer"},
      {"id":"c4","name":"NATE Certification","issuer":"North American Technician Excellence","badgeImageUrl":null,"earnedDate":"2022-11-01","expiryDate":"2027-11-01","verificationUrl":"https://natex.org/verify/lferrer"}
    ]', 'lferrer-demo3'),
  ('Priya Nair', 'Safety Officer', 'EHS / Safety', 'Midland, TX', '(555) 077-2260', 'p.nair@fieldcred.co',
   '["Incident investigation","Hazard assessment","Training delivery"]',
   '[
      {"id":"c1","name":"OSHA 30-Hour Construction","issuer":"U.S. OSHA","badgeImageUrl":null,"earnedDate":"2021-01-01","expiryDate":"2028-01-01","verificationUrl":"https://osha.gov/verify/pnair"},
      {"id":"c2","name":"First Aid / CPR / AED","issuer":"American Red Cross","badgeImageUrl":null,"earnedDate":"2024-01-01","expiryDate":"2027-01-01","verificationUrl":"https://redcross.org/verify/pnair"},
      {"id":"c3","name":"Confined Space Entry","issuer":"NCCER","badgeImageUrl":null,"earnedDate":"2023-01-01","expiryDate":"2028-01-01","verificationUrl":"https://nccer.org/verify/pnair"},
      {"id":"c4","name":"NFPA 70E Arc Flash Safety","issuer":"NFPA","badgeImageUrl":null,"earnedDate":"2023-05-01","expiryDate":"2028-05-01","verificationUrl":"https://nfpa.org/verify/pnair"},
      {"id":"c5","name":"HAZWOPER 40-Hour","issuer":"U.S. OSHA","badgeImageUrl":null,"earnedDate":"2022-02-01","expiryDate":"2027-02-01","verificationUrl":"https://osha.gov/verify/pnair-haz"},
      {"id":"c6","name":"Fall Protection","issuer":"NCCER","badgeImageUrl":null,"earnedDate":"2023-08-01","expiryDate":"2028-08-01","verificationUrl":"https://nccer.org/verify/pnair-fall"}
    ]', 'pnair-demo4'),
  ('Tom Braddock', 'Pipefitter', 'Mechanical', 'Beaumont, TX', '(555) 033-9915', 't.braddock@fieldcred.co',
   '["Pipe fabrication","Blueprint reading","Rigging basics"]',
   '[
      {"id":"c1","name":"Pipefitting Journeyman Card","issuer":"United Association","badgeImageUrl":null,"earnedDate":"2020-01-01","expiryDate":"2030-01-01","verificationUrl":"https://ua.org/verify/tbraddock"},
      {"id":"c2","name":"OSHA 10-Hour Construction","issuer":"U.S. OSHA","badgeImageUrl":null,"earnedDate":"2022-01-01","expiryDate":"2027-01-01","verificationUrl":"https://osha.gov/verify/tbraddock"},
      {"id":"c3","name":"Rigging & Signaling","issuer":"NCCER","badgeImageUrl":null,"earnedDate":"2020-05-12","expiryDate":"2026-05-12","verificationUrl":"https://nccer.org/verify/tbraddock"}
    ]', 'tbraddock-demo5'),
  ('Grace Oduya', 'Crane Operator', 'Rigging', 'Corpus Christi, TX', '(555) 061-4472', 'g.oduya@fieldcred.co',
   '["Load charts","Signal communication","Site inspection"]',
   '[
      {"id":"c1","name":"NCCCO Mobile Crane Operator","issuer":"NCCCO","badgeImageUrl":null,"earnedDate":"2022-01-01","expiryDate":"2027-01-01","verificationUrl":"https://nccco.org/verify/goduya"},
      {"id":"c2","name":"Rigging Level I","issuer":"NCCER","badgeImageUrl":null,"earnedDate":"2023-01-01","expiryDate":"2028-01-01","verificationUrl":"https://nccer.org/verify/goduya"},
      {"id":"c3","name":"OSHA 10-Hour Construction","issuer":"U.S. OSHA","badgeImageUrl":null,"earnedDate":"2022-06-01","expiryDate":"2027-06-01","verificationUrl":"https://osha.gov/verify/goduya"},
      {"id":"c4","name":"Aerial Lift Operator","issuer":"NCCER","badgeImageUrl":null,"earnedDate":"2023-08-20","expiryDate":"2026-08-20","verificationUrl":"https://nccer.org/verify/goduya-lift"}
    ]', 'goduya-demo6'),
  ('Owen Castillo', 'Structural Inspector', 'Structural', 'Austin, TX', '(555) 088-6603', 'o.castillo@fieldcred.co',
   '["Weld inspection","NDT methods","Report writing"]',
   '[
      {"id":"c1","name":"AWS Certified Welding Inspector","issuer":"American Welding Society","badgeImageUrl":null,"earnedDate":"2021-09-01","expiryDate":"2027-09-01","verificationUrl":"https://aws.org/verify/ocastillo"},
      {"id":"c2","name":"ASNT NDT Level II","issuer":"ASNT","badgeImageUrl":null,"earnedDate":"2022-04-01","expiryDate":"2027-04-01","verificationUrl":"https://asnt.org/verify/ocastillo"},
      {"id":"c3","name":"OSHA 30-Hour Construction","issuer":"U.S. OSHA","badgeImageUrl":null,"earnedDate":"2023-02-01","expiryDate":"2028-02-01","verificationUrl":"https://osha.gov/verify/ocastillo"}
    ]', 'ocastillo-demo7'),
  ('Elena Vasquez', 'Electrical Apprentice', 'Electrical', 'Houston, TX', '(555) 015-7729', 'e.vasquez@fieldcred.co',
   '["Conduit bending","Panel wiring"]',
   '[
      {"id":"c1","name":"OSHA 10-Hour Construction","issuer":"U.S. OSHA","badgeImageUrl":null,"earnedDate":"2023-03-01","expiryDate":"2028-03-01","verificationUrl":"https://osha.gov/verify/evasquez"},
      {"id":"c2","name":"First Aid / CPR","issuer":"American Red Cross","badgeImageUrl":null,"earnedDate":"2023-05-01","expiryDate":"2026-05-01","verificationUrl":"https://redcross.org/verify/evasquez"}
    ]', 'evasquez-demo8')
on conflict (public_slug) do nothing;
