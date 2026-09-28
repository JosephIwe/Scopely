-- 003_reference_data: the first two playbooks, shared issue codes, v1 rules, the service
-- catalog and the two initial markets.
--
-- Provenance: every VALIDATED status cites golden-set cases (fixtures/golden) that were
-- observed and recorded by hand in JosephIwe/OutboundOS rounds 1 and 2 (23-24 Sep 2026).
-- VALIDATED means the DETECTION is backed by real recorded observations. It says nothing
-- about whether the finding sells: commercial_status is UNPROVEN for everything here,
-- because no reply, win or revenue data exists yet.
--
-- Unknowns are left NULL on purpose: implementation_type, delivery effort, margins,
-- prerequisites and close rates are not recorded anywhere in the source material.

SET search_path = scopely;

INSERT INTO niche_playbooks (key, name, description, verticals, subverticals, validation_status, validation_basis, definition) VALUES
('aesthetics', 'Aesthetics clinics',
 'Independent aesthetic, skin and med-spa clinics. Initial BENCHMARK playbook: its rules are checked against ~100 hand-audited London clinics.',
 ARRAY['aesthetics'], ARRAY['aesthetic_clinic','skin_clinic','med_spa','medical_aesthetics','beauty_clinic'],
 'VALIDATED', 'Detection rules backed by OutboundOS round 1 (50 businesses) and round 2 (53 businesses) recorded evidence; see fixtures/golden.',
 '{"discovery_terms":["aesthetic clinic","skin clinic","med spa","medical aesthetics"],"benchmark_geography":"GB/London"}'),
('uk_trades_lead_recovery', 'UK trades (Lead Recovery)',
 'UK home-service trades: plumbing, heating/HVAC, electrical, roofing. EXPERIMENTAL market for the Lead Recovery solution pack. No audits have been recorded yet.',
 ARRAY['home_services'], ARRAY['plumbing','hvac','electrical','roofing'],
 'HYPOTHESIS', NULL,
 '{"source":"OutboundOS docs/02-home-services-outbound-design.md (2026-09-25), design only","research_split":{"plumbing":0.40,"hvac":0.25,"electrical":0.20,"roofing":0.15}}');

-- ------------------------------------------------------------------ issue codes

INSERT INTO issue_codes (code, playbook_id, kind, title, description, default_confidence, lead_eligible, validation_status, validation_basis) VALUES
('E-TEL-BROKEN', NULL, 'issue', 'Phone link malformed',
 'A tel: href is malformed or does not match the number shown (e.g. trunk 0 kept after +44, text inside the href).',
 'HIGH', true, 'VALIDATED', 'golden r1-the-mw-clinic-london (tel:WhatsApp:), r2-vie-aesthetics (tel:+440...)'),
('E-WA-BROKEN', NULL, 'issue', 'WhatsApp link malformed',
 'A WhatsApp link has no number or a number WhatsApp cannot use (no country code).',
 'HIGH', true, 'VALIDATED', 'golden r2-london-aesthetic-medicine (api.whatsapp.com/send?phone=07858668579)'),
('E-LINK-TARGET-MISMATCH', NULL, 'issue', 'Contact label opens a different channel',
 'The visible label names one channel (e.g. WhatsApp) but the link opens another (phone call, email).',
 'HIGH', true, 'VALIDATED', 'golden r1-the-mw-clinic-london (WhatsApp label -> tel:), r2-fierce-face-skin-clinic (WhatsApp label -> mailto:)'),
('E-EMAIL-INVALID', NULL, 'issue', 'Published email or email link cannot reach a mailbox',
 'A published email uses a placeholder or undeliverable domain, or an email link is not a working mailto: link.',
 'HIGH', true, 'VALIDATED', 'golden r2-the-bronte-clinic (info@bronte-clinic-old.local)'),
('E-PLACEHOLDER-LINK', NULL, 'issue', 'Template placeholder link',
 'A live page carries template placeholder targets (placeholder phone numbers, template-vendor docs links).',
 'MEDIUM', true, 'HYPOTHESIS', NULL),
('E-CTA-DEAD-END', NULL, 'issue', 'Booking call-to-action leads nowhere useful',
 'A Book/Enquire call-to-action links to itself, to #, to a booking URL that does not load, or to a page without the promised booking or offer.',
 'MEDIUM', true, 'HYPOTHESIS', NULL),
('E-FORM-BROKEN', NULL, 'issue', 'Enquiry form broken',
 'A form posts to a missing endpoint or a mailto on a dead domain.',
 'HIGH', true, 'HYPOTHESIS', NULL),
('E-BOOK-TO-ENQUIRY', NULL, 'issue', 'Booking CTA leads to an enquiry or callback form',
 'Every booking call-to-action ends at a general enquiry or callback form and no self-booking platform is observed. JavaScript widgets must be ruled out before this is claimed.',
 'MEDIUM', true, 'VALIDATED', 'golden r1-phi-clinic, r1-wimpole-aesthetics, r1-dr-haus-dermatology-clinic, r2-newlife-aesthetics'),
('E-STALE-SIGNAL', NULL, 'issue', 'Stale site signal',
 'Old copyright year, old domain in contact details, or similar signs the site is not maintained. Never the lead line.',
 'LOW', false, 'VALIDATED', 'golden r1-avika-aesthetics-clinic (2023), r1-absolute-aesthetics (2021), r1-body-silktm-clinic (2010-2018)'),
('E-CONTENT-ERROR', NULL, 'issue', 'Content error',
 'Typos in addresses or labels. Never the lead line.',
 'LOW', false, 'VALIDATED', 'golden r2-the-bronte-clinic (postcode printed WIG 0PW)'),
('E-ABSENT-FEATURE', NULL, 'issue', 'Feature absent',
 'A feature is simply missing (no WhatsApp, no booking). Weak on its own and never the lead line.',
 'LOW', false, 'VALIDATED', 'golden r1-avika-aesthetics-clinic (mobile number only, no WhatsApp link seen)'),
('O-BOOKING-PLATFORM', NULL, 'observation', 'Self-booking platform present',
 'A third-party or own self-booking flow is present (Pabau, Phorest, Zenoti, Setmore, Semble, Calendly, ...). Usually means booking is already solved.',
 NULL, false, 'VALIDATED', 'golden round 2 rejections, e.g. r2-omniya-clinic (Semble), r2-clinicbe (Pabau), r2-injectual (Zenoti)');

INSERT INTO issue_codes (code, playbook_id, kind, title, description, default_confidence, lead_eligible, validation_status, validation_basis)
SELECT v.code, p.id, 'issue', v.title, v.description, v.conf, true, 'HYPOTHESIS', NULL
  FROM niche_playbooks p,
  (VALUES
    ('E-24-7-CONTRADICTION', 'Round-the-clock claim contradicted', 'Site claims 24/7 or emergency service but published hours or routes contradict it.', 'HIGH'),
    ('E-OOH-NOROUTE', 'No out-of-hours route', 'Hours are stated and no out-of-hours enquiry route is observed.', 'MEDIUM'),
    ('E-MOBILE-ONLY', 'Mobile-only leave-a-message path', 'The only contact is a mobile with "we may be on a job, leave a message" style wording.', 'MEDIUM'),
    ('E-NO-NEXT-STEP', 'Enquiry with no stated next step', 'A quote or enquiry form states no next step or timing.', 'MEDIUM'),
    ('E-REVIEW-RESPONSE', 'Dated review about no response', 'A public review from the last 12 months complains about no call back. Quote only.', 'HIGH')
  ) AS v(code, title, description, conf)
 WHERE p.key = 'uk_trades_lead_recovery';

-- ------------------------------------------------------------------ rule versions (v1)

INSERT INTO rule_versions (rule_key, version, kind, playbook_id, description, validation_status, validation_basis, definition) VALUES
('check.contact_links', 1, 'check', NULL,
 'Parse tel:, WhatsApp (wa.me, api.whatsapp.com), mailto: and sms: hrefs; compare with visible labels; check number format and mail domain.',
 'VALIDATED', 'golden r1-the-mw-clinic-london, r2-fierce-face-skin-clinic, r2-london-aesthetic-medicine, r2-vie-aesthetics, r2-the-bronte-clinic',
 '{"issue_codes":["E-TEL-BROKEN","E-WA-BROKEN","E-LINK-TARGET-MISMATCH","E-EMAIL-INVALID"]}'),
('check.booking_cta_trace', 1, 'check', NULL,
 'Follow every Book/Enquire/Contact call-to-action and classify the destination (self-booking, callback form, enquiry form, anchor, self-link, error).',
 'VALIDATED', 'golden r1-phi-clinic, r1-wimpole-aesthetics, r1-dr-haus-dermatology-clinic, r2-newlife-aesthetics',
 '{"issue_codes":["E-BOOK-TO-ENQUIRY","E-CTA-DEAD-END"]}'),
('check.booking_platform_fingerprint', 1, 'check', NULL,
 'Detect self-booking platforms from script, iframe and link signatures.',
 'VALIDATED', 'golden round 2 SERVICE_ALREADY_SOLVED rejections',
 '{"issue_codes":["O-BOOKING-PLATFORM"],"platforms_seen":["Pabau","Phorest","Zenoti","Setmore","Semble","Calendly","Acuity","Collums","LeadConnector","Wilford"]}'),
('check.placeholder_links', 1, 'check', NULL,
 'Flag placeholder phone numbers and template-vendor links on live pages.',
 'HYPOTHESIS', NULL, '{"issue_codes":["E-PLACEHOLDER-LINK"]}'),
('check.stale_signals', 1, 'check', NULL,
 'Copyright years, old domains in contact details, address and label typos.',
 'VALIDATED', 'golden r1-avika-aesthetics-clinic, r1-absolute-aesthetics, r2-the-bronte-clinic',
 '{"issue_codes":["E-STALE-SIGNAL","E-CONTENT-ERROR"]}'),
('qualify.business_type', 1, 'qualification', NULL,
 'Reject businesses outside the market''s vertical (product brands, retailers, publishers, other specialties).',
 'VALIDATED', 'golden round 1 WRONG_BUSINESS_TYPE rejections, e.g. r1-clear, r1-medino', '{}'),
('qualify.trading_status', 1, 'qualification', NULL,
 'Reject businesses that have ceased trading (site notice, dissolved or liquidated company).',
 'VALIDATED', 'golden r1-london-dermatology-clinic, r2-eudelo', '{}'),
('qualify.independence', 1, 'qualification', NULL,
 'Reject chains and groups when the market targets independents.',
 'VALIDATED', 'golden r1-cultbrands-cultskin, r2-swiss-care-swiss-aesthetics', '{}'),
('qualify.service_already_solved', 1, 'qualification', NULL,
 'Reject when the capability the catalog sells is already working (e.g. self-booking live) and nothing else is broken.',
 'VALIDATED', 'golden round 2 rejections with working booking platforms', '{}'),
('qualify.legitimate_reason', 1, 'qualification', NULL,
 'Do not treat a process as friction when it has a legitimate reason (e.g. clinical triage before booking).',
 'VALIDATED', 'golden r2-skin55, r2-the-devonshire-clinic', '{}'),
('qualify.corporate_subscriber', 1, 'qualification', NULL,
 'UK: cold B2B email only to corporate subscribers (Ltd/LLP, Active). Sole traders and partnerships need consent (PECR).',
 'VALIDATED', 'ICO B2B marketing guidance as recorded in OutboundOS docs/02 section 1.5; applied in round 2 (r2-lesley-leale-green held)', '{"country_code":"GB"}'),
('qualify.historical_manual_review', 1, 'qualification', NULL,
 'The manual Claude + operator audit used in OutboundOS rounds 1-2. Recorded so imported historical decisions have a traceable rule.',
 'VALIDATED', 'OutboundOS research/qualification-50.md and research/round2/round2-report.md', '{}'),
('mapping.catalog_v1', 1, 'mapping', NULL,
 'Map issue codes to catalog items using catalog_items.supported_issue_codes.',
 'HYPOTHESIS', NULL, '{}');

INSERT INTO rule_versions (rule_key, version, kind, playbook_id, description, validation_status, validation_basis, definition)
SELECT 'check.trades_hours_and_routes', 1, 'check', p.id,
       'Extract opening hours, 24/7 claims, out-of-hours routes, response promises and mobile-only wording.',
       'HYPOTHESIS', NULL,
       '{"issue_codes":["E-24-7-CONTRADICTION","E-OOH-NOROUTE","E-MOBILE-ONLY","E-NO-NEXT-STEP"]}'
  FROM niche_playbooks p WHERE p.key = 'uk_trades_lead_recovery';

-- ------------------------------------------------------------------ service catalog

INSERT INTO catalog_items (key, service, description, price_low, price_high, currency, price_source,
                           supported_issue_codes, supported_verticals, components, verification_checks, playbook_id) VALUES
('website_fix_sprint', 'Website Fix Sprint',
 'Fixed-price repair of broken or misleading contact paths and small site defects.',
 120, 120, 'GBP',
 'OutboundOS outreach/final-package-round1.md (2026-09-23): "Prices are in GBP (Website Fix Sprint £120, Booking & Lead Automation Sprint £240)"',
 ARRAY['E-TEL-BROKEN','E-WA-BROKEN','E-LINK-TARGET-MISMATCH','E-EMAIL-INVALID','E-PLACEHOLDER-LINK','E-CTA-DEAD-END','E-FORM-BROKEN','E-STALE-SIGNAL','E-CONTENT-ERROR'],
 '{}', '{}', ARRAY['check.contact_links','check.placeholder_links','check.stale_signals'], NULL),
('booking_lead_automation_sprint', 'Booking & Lead Automation Sprint',
 'Let new clients book directly, or acknowledge enquiries instantly with a booking link and follow-up.',
 240, 240, 'GBP',
 'OutboundOS outreach/final-package-round1.md (2026-09-23): "Prices are in GBP (Website Fix Sprint £120, Booking & Lead Automation Sprint £240)"',
 ARRAY['E-BOOK-TO-ENQUIRY','E-NO-NEXT-STEP'],
 '{}', '{}', ARRAY['check.booking_cta_trace','check.booking_platform_fingerprint'], NULL);

INSERT INTO catalog_items (key, service, description, price_low, price_high, currency, price_source,
                           supported_issue_codes, supported_verticals, supported_subverticals, components, verification_checks, playbook_id)
SELECT 'lead_recovery_system', 'Lead Recovery System',
       'First commercial solution pack: close the gap between an enquiry arriving and the business responding.',
       350, 500, 'GBP',
       'OutboundOS docs/02-home-services-outbound-design.md (2026-09-25) section 7.1: "Usually £350 to £500, depending on what you already use"',
       ARRAY['E-24-7-CONTRADICTION','E-OOH-NOROUTE','E-MOBILE-ONLY','E-NO-NEXT-STEP','E-REVIEW-RESPONSE','E-TEL-BROKEN','E-WA-BROKEN','E-FORM-BROKEN'],
       ARRAY['home_services'], ARRAY['plumbing','hvac','electrical','roofing'],
       ARRAY['missed_call_text_back','after_hours_capture','enquiry_acknowledgement','whatsapp_sms_response','callback_booking','follow_up'],
       ARRAY['check.trades_hours_and_routes','check.contact_links'], p.id
  FROM niche_playbooks p WHERE p.key = 'uk_trades_lead_recovery';

-- ------------------------------------------------------------------ markets

INSERT INTO markets (name, playbook_id, vertical, country_code, city, timezone, currency, purpose)
SELECT 'London aesthetics (benchmark)', id, 'aesthetics', 'GB', 'London', 'Europe/London', 'GBP', 'benchmark'
  FROM niche_playbooks WHERE key = 'aesthetics';
INSERT INTO markets (name, playbook_id, vertical, country_code, timezone, currency, purpose)
SELECT 'UK trades, Lead Recovery (experiment)', id, 'home_services', 'GB', 'Europe/London', 'GBP', 'experiment'
  FROM niche_playbooks WHERE key = 'uk_trades_lead_recovery';
