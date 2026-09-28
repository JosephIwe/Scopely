# Round 2 London clinic prospects: research report

Prepared 24 Sep 2026 for Joseph Iwe. Research only. Nothing has been sent or scheduled, no Clay records were changed, and no paid enrichment was run.

## Summary

- 53 clinics audited: 41 new from Clay searches in the BuildWise cold outreach Workspace (1390580), plus 12 unused Keep/Check leads from round 1.
- **5 are ready for outreach**, 12 need further verification, and 36 are rejected.
- I did not pad the list to reach 10. Most independent London clinics already have working self-booking (Pabau, Phorest, Zenoti, Setmore, Semble), which rules out the £240 offer. For the £120 offer, the site needs a real broken link.
- All 5 ready prospects are limited companies, so they count as corporate subscribers under PECR. All 5 emails were published by the clinic itself. Four are GENERAL inboxes; one is a named COO address.

## How this was done, and its limits

- **Clay.** The Clay connection can search and enrich, but it cannot read existing Clay tables. "Reuse existing records" therefore meant the round 1 files (qualification-50, contacts-final-9). I did not inspect the tables. I ran 3 company searches and 3 "load more" pages, one at a time. They were free searches, and no enrichment or Work Email function was run.
- **Websites** were read with a page-fetch tool, because this environment blocks real browsers. That tool cannot run JavaScript, see chat or booking widgets, test mobile layouts, submit forms or see confirmations. No form was submitted and nothing was tested on a phone. Every finding below is a link or text observed in the page source. The five ready prospects' key hrefs were re-fetched and checked a second time.
- **Companies House** search was broken through the proxy: it returned the same result for every query. Company numbers came from clinic legal text, the CQC register or web search, and each company page was then opened directly. A few pages returned 403 or 429 errors, and those cases are flagged.
- **Emails**: none were guessed or constructed. "Verified" is never claimed; the round 1 Clay emails also carried no verification data.

## A. Ready for outreach

| Clinic | Website | Decision-maker | Job title | Email | Type | Verified website issue | Exact page or CTA | Proposed fix | Offer | Evidence URL | Confidence | Caveats |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Fierce Face Skin Clinic (Clapham SW4) | fierce-face.com | Henrietta Hoppenbrouwers | Founder ("Founded by Henrietta"); director at Companies House | hello@fierce-face.com | GENERAL | The link text "07376 617711 (Whatsapp only)" is coded as `mailto:hello@fierce-face.com`, so it opens email, not WhatsApp. The email link has no `mailto:` and resolves to fierce-face.com/hello@fierce-face.com, which returns 404. | Homepage contact block | Change the WhatsApp link to `https://wa.me/447376617711` and the email href to `mailto:hello@fierce-face.com` | £120 | https://www.fierce-face.com/ | HIGH | Setmore self-booking works, so this is not a £240 prospect. Surname comes from Companies House (FIERCE FACE AESTHETICS UK LIMITED 12235429, Active); the site gives only "Henrietta". Not tested on a phone. |
| London Aesthetic Medicine (4 Harley St W1G) | london-aesthetic-medicine.com | Dr Uliana Gout | Founder and Medical Director; director at Companies House | clinic@london-aesthetic-medicine.com | GENERAL | The main WhatsApp icons (4 on the homepage) link to `api.whatsapp.com/send?phone=07858668579`: UK national format, no 44 country code. WhatsApp needs international format. Only the footer link (`wa.me/447858668579`) is correct. The phone link is `tel:+44 (0) 207 637 5999`. | Header and body WhatsApp icons; phone link | Point all WhatsApp icons to `wa.me/447858668579`; change the phone link to `tel:+442076375999` | £120 | https://www.london-aesthetic-medicine.com/ | HIGH | The href was quoted verbatim on 3 fetches. The phone behaviour (WhatsApp's "invalid number" message) was not tested on a device; test once before sending. Pabau booking is already live. LONDON AESTHETIC MEDICINE LTD 08670361, Active. |
| NewLife Aesthetics (Raynes Park SW20) | newlifeaesthetics.co.uk | Mo Ashraf | Managing Director | info@newlifeaesthetics.co.uk | GENERAL | "Book Consultation" goes to /contact/, a general enquiry form (name, email, mobile, treatment, message, "Send Enquiry"). The FAQ says the team "aims to respond ... as soon as reasonably possible". No booking system is referenced on the page. | "Book Consultation" (homepage, twice) | Self-booking for the free consultation slot, or an instant auto-reply to enquiries carrying a booking link plus a follow-up | £240 | https://newlifeaesthetics.co.uk/contact/ | MEDIUM | A consultation before treatment is clinically reasonable, so the pitch is booking the free consult slot, not skipping it. A widget loaded by JavaScript can't be ruled out. "Mo" = director Musharraf Ashraf (NEWLIFE MEDICAL AESTHETICS LTD 11248596) is inferred from the matching address. |
| Vie Aesthetics (Holborn WC1X; also Rayleigh, Essex) | vie-aesthetics.com | Vicky Grammatikopoulou (founder); Richard Hughes (COO) | Founder & CEO; Chief Operating Officer | RichardH@vie-aesthetics.com | DIRECT (COO) | Header phone links are `tel:+4402033438500` (London) and `tel:+4401268778615` (Rayleigh). Both keep the trunk 0 after +44; the correct forms are `tel:+442033438500` and `tel:+441268778615`. One audit also saw an empty "Germany" `tel:` link in the header; my re-check didn't show it. | Header phone list, every page | Correct both tel: links; remove or fill the Germany item; optionally add a wa.me link for the mobile number | £120 | https://www.vie-aesthetics.com/ | MEDIUM | Some phones auto-correct "+440", so frame it as a fix, not "your phone link fails". Round 1 rated this clinic low need, and it has sites outside London. The RichardH@ address is published for general enquiries in the privacy notice. vicky@ is published as the data-protection contact, so I didn't use it. VIE AESTHETICS LTD 08726192, Active. |
| The Bronte Clinic (33 Cavendish Sq W1G; also Guildford) | thebronteclinic.com | Dr Fiona McCarthy | Medical Director and Founder | info@thebronteclinic.com | GENERAL | The privacy policy gives the only data-protection contact as `info@bronte-clinic-old.local`, a placeholder that cannot receive mail. The postcode is printed "WIG 0PW" (letter I) on the homepage, contact, booking and privacy pages; it should be W1G 0PW. | /document/privacy-policy/; address block site-wide | Replace the placeholder email; correct the postcode; confirm the booking-page form renders | £120 | https://thebronteclinic.com/document/privacy-policy/ | MEDIUM | Both quotes re-checked. The booking page says "use the form below" but no form was in the page source; it is probably loaded by JavaScript (HubSpot or Pabau), so don't claim it's broken. CQC names the provider as Hilaf Limited (11164882); Companies House returned 403, so its status and directors are unconfirmed. Check them before sending. |

## B. Needs further verification

| Clinic | What looks promising | What's unresolved |
|---|---|---|
| City Dermatology Clinic (4 Harley St + EC4) | Every "Enquire Now" opens a callback popup ("Our skin advisors will contact you back"), yet the site advertises a fixed £100 doctor consultation, "no referral needed" and same-day see-and-treat. Good £240 fit. info@ (GENERAL). | Decision-maker is my inference: Dr Andreea Anton, sole director of ANDREEA MEDICAL LTD 10254910; the site names no owner. Also has Birmingham and Dubai clinics. A booking widget inside the popup can't be ruled out. |
| 23MD Clinics (Chelsea SW3) | No online booking: enquiry forms and phone only. £240 fit. Co-founder Dr Suha Kersh (with Dr Martin Galy). | No email published. Also has a Dubai clinic. Companies House (23MD MEDICAL SERVICES LIMITED 11375909) shows accounts that may be overdue. Needs a browser check for a widget. |
| Dr Rasha Clinic (Knightsbridge) | Page source contains "Book", "Shop", "Clinic" links pointing to `finsweet.com/client-first/docs` (a Webflow template placeholder), and "Book your appointment Now" links to `#`. | My re-check found these links, but could not tell whether they are visible or in a hidden template menu. Phorest booking works. A browser check is needed before claiming anything. |
| Lesley Leale-Green (Dulwich SE21) | On /booknow, "Schedule an Appointment" links back to /booknow itself; the WhatsApp number and phone are plain text, not links. £120 fit. Founder Lesley Leale-Green; clinic@ (GENERAL). | No limited company found, so this may be a sole trader: PECR requires prior consent before emailing. Needs a browser check. |
| Effect Doctors (Soho W1D, Westfield W12) | The hero "Book Now 10% Off" lands on the Westfield page, which has no booking link and no 10% offer. £120 fit. info@ (GENERAL); MOBILE DOCTORS COLLECTIVE LTD. | Borderline fit for our market (IV drips and wellness-led); partner clinics include Saudi Arabia. A booking widget may be loaded by JavaScript. |
| The Avanti Aesthetics Clinic (W1W) | The footer "Book An Appointment" points to an old Pabau address (bookings.php?compid=8396) that wouldn't load; "Pricing" in the menu opens booking, not prices. | No usable email (Cloudflare-protected). The similarly named AVANTI AESTHETICS LIMITED was dissolved after insolvency; the trading company is AVANTI AESTHETICS ACADEMY LTD. The dead link needs confirming in a browser. |
| Expert Medical (Oxford Circus) | On /laser-hair-removal the footer displays 0800 955 8891 but links to `tel:+447700000000`, which looks like a placeholder. | The fetch results contradicted each other; the decision-maker (Sara Dhada Surti, from CQC and Companies House) is not named on the site; the Book buttons load by JavaScript. |
| Clinica London (Harley St) | "Book a Consultation" leads to a request-a-callback form. Founder Jane Olver; contact@ (GENERAL). | Consultant eye and skin triage is a fair clinical reason for a callback. The form loads by JavaScript. Weak £240 case. |
| WY Skin Clinic, formerly Waterhouse Young (39 Harley St) | "Book an Appointment" is a form where the team "will be in touch to arrange". £240 fit. | Owner not identified; the old company was dissolved in May 2025 and the current trading company is unconfirmed; the site uses two email domains. |
| Dermaperfect (137 Harley St) | Contact page says "fill in the form below" but no form is in the page source; phone shown as "+44 0207…" with no tel: link. | Email is Cloudflare-protected. Company status is unconfirmed (rate-limited). Also has an Athens clinic. |
| The Laser Clinic Group | "Book appointment" is an enquiry form with a 24-hour wait, and the clinic dropdown omits Hounslow. | No decision-maker anywhere. Clinics are in Uxbridge, Windsor and Hounslow; Clay's "Ealing" listing is wrong. The company has had no officers since 2016, so PECR is a risk. |
| Unreachable sites: The Lovely Clinic, Paradise Aesthetic Clinic, House of Saab, The Dolls London, Enhance For Life, Chiswick Clinic | These are plausible independent clinics. | Their sites would not load for the fetch tool (timeouts, DNS, 403 or SSL errors), so nothing could be audited. Enhance For Life's SSL mismatch could itself be a £120 fix if a real browser shows the same warning. |

## C. Rejected

| Clinic | Reason |
|---|---|
| EUDELO | Ceased trading; insolvency notice on the homepage. |
| Primas Medispa | Appears closed; the likely company is in liquidation. |
| Tempus Belgravia | Rebranded to Founders Health (Founders Forum Group) and already has self-booking. |
| Lisa Franklin London | Company renamed and the founder resigned in June 2026; site returns 401. |
| Private Harley Street Clinic | Site is Covid-testing era (latest posts from 2022) and accounts are overdue; unclear it still trades in aesthetics. |
| Continental Skin Clinic | No decision-maker; its company was dissolved in 2024. |
| Neogleam Clinic | CQC registration archived in January 2025; site mostly unreachable. |
| Cosmedics Skin Clinics | Working booking platform (Wilford); the company named on its site was dissolved. |
| Swiss Care / Swiss Aesthetics | Five-branch group with no founder-level contact. |
| ALTA Medi | Three sites in two countries; Phorest self-booking works. The round 1 WhatsApp claim no longer holds. |
| CosmeDocs | Multi-country group; Acuity booking and WhatsApp work. |
| The Aesthetics Club UK | Five-clinic group (four in Scotland); Phorest booking works. |
| Injectual | Three sites, 12+ clinicians; Zenoti booking works. |
| Skin Design London | Mainly a product brand; Zenoti booking works. |
| Omniya Clinic | Semble self-booking on the booking page. |
| Clinicbe | Pabau booking works; no defect found. |
| Adonia Medical Clinic | Zenoti booking works; the footer route is one extra click, not a dead end. |
| Medicetics | Calendly for new clients and Pabau for returning clients: booking already solved. |
| Dermasurge | Online self-booking with deposit works; the only issue is a form label typo. |
| Harley Street Skin Clinic | Own booking site with card payment; surgery routed through a coordinator for clinical reasons. |
| The Devonshire Clinic | Consultant dermatology practice; collecting GP and insurance details is a legitimate medical step. |
| Skin55 | Consultant dermatology practice; phone and enquiry booking is clinically justified; nothing broken. |
| D.Thomas Clinic | Zenoti booking and a correct WhatsApp link. |
| Aesthetics Lab | Pabau booking works; no email published. |
| ASKINOLOGY | Collums booking works; possible sole trader. |
| Belle Clinic | Setmore booking and WhatsApp work. |
| nakedhealth Medispa | Phorest booking and correct WhatsApp and phone links. |
| Nova Aesthetic Clinic | Pabau booking works. |
| Exclusive Aesthetics & Wellbeing | Self-booking calendar (LeadConnector) in place. |
| DR SNA Clinic | Own booking flow with Stripe; links well-formed. |
| Ace Skin Health Clinic | Pabau booking in place. |
| Other off-target Clay results (dentists, product brands, agencies, training academies, surgery-only practices, medical-tourism firms) | Not clinics in our target market; not audited. |
| Round 1 exclusions (the 11 contacted clinics, Cosmetic Skin Clinic, Body Silk, GHB Clinic) | Excluded as instructed. PHI, Dr Haus, Avika, Harper, Absolute, Montrose, MW Clinic, Cosmetic Skin Clinic, Body Silk and GHB reappeared in the Clay results and were skipped. |

## UK email compliance check (PECR and UK GDPR)

- PECR lets you send unsolicited B2B marketing email to **corporate subscribers** (limited companies, LLPs) without prior consent, provided you identify yourself and give a simple way to opt out. Sole traders and ordinary partnerships count as individual subscribers and need prior consent. All 5 ready prospects are limited companies (Bronte's is via CQC and still to be confirmed at Companies House). Lesley Leale-Green and the Laser Clinic Group are held back partly for this reason.
- Under UK GDPR, a named person's work email (the Vie COO address) is personal data. Legitimate interests is the usual basis. Keep the message relevant to their role, say where you found the address if asked, honour "no" immediately and keep a suppression list. The opt-out line you specified covers the opt-out requirement.
- Sending setup: round 1 found that Resend's policy bans cold outreach. Your ijosephiwe@gmail.com address avoids that. Send one email at a time by hand; don't use bulk tools.

## Credit control: optional paid step (not run)

- **What's missing:** a direct email for the decision-maker at 4 of the 5 ready clinics (Fierce Face, LAM, NewLife, Bronte). All four have usable GENERAL inboxes, so this is optional.
- **Enrichment needed:** Clay's Work Email function, one run per person (4 runs).
- **Estimated cost:** unknown. Clay's result showed no credit amount in round 1, and this connection cannot see the credit balance.
- **Free alternative:** use the published GENERAL inbox addressed to the named person ("For Dr Gout"). That's what the table assumes.
- **Your approval** is needed before I run it.

## Phase 5: outreach preparation (ready prospects only)

**1. Fierce Face Skin Clinic**
- CLINIC: Fierce Face Skin Clinic, Clapham
- CONTACT NAME: Henrietta
- EMAIL: hello@fierce-face.com (GENERAL)
- SUBJECT: Your "WhatsApp only" link opens email
- PERSONALIZATION FACT: Founder-run skin clinic in Abbeville Mews, Clapham, with Setmore self-booking and prices from free consultations.
- VERIFIED ISSUE: "07376 617711 (Whatsapp only)" is linked to mailto:hello@, and the hello@ link itself leads to a 404 page.
- PROPOSED FIX: Link the number to wa.me/447376617711 and fix the email link.
- OFFER: £120 Website Fix Sprint
- EMAIL ANGLE: People who tap "WhatsApp only" land in their email app instead, and the email link goes to a 404. Two small link fixes, done in a day.
- EVIDENCE URL: https://www.fierce-face.com/

**2. London Aesthetic Medicine**
- CLINIC: London Aesthetic Medicine (LAM), 4 Harley Street
- CONTACT NAME: Dr Uliana Gout
- EMAIL: clinic@london-aesthetic-medicine.com (GENERAL)
- SUBJECT: The WhatsApp icons on your site
- PERSONALIZATION FACT: Founded by Dr Gout in 2011; she is a past BCAM President.
- VERIFIED ISSUE: The main WhatsApp icons use phone=07858668579 with no country code; only the footer link has the correct 447858668579.
- PROPOSED FIX: Point every icon to wa.me/447858668579 and tidy the tel: link.
- OFFER: £120 Website Fix Sprint
- EMAIL ANGLE: The footer WhatsApp link works, but the icons most people tap use a format WhatsApp doesn't accept. Test it on a phone before sending, and only say what you saw.
- EVIDENCE URL: https://www.london-aesthetic-medicine.com/

**3. NewLife Aesthetics**
- CLINIC: NewLife Aesthetics, Raynes Park
- CONTACT NAME: Mo Ashraf
- EMAIL: info@newlifeaesthetics.co.uk (GENERAL)
- SUBJECT: "Book Consultation" on your site
- PERSONALIZATION FACT: Mo has 30+ years in aesthetics and runs the Coombe Lane clinic, which offers complimentary consultations.
- VERIFIED ISSUE: "Book Consultation" opens a general enquiry form with no way to pick a time; the site says the team replies "as soon as reasonably possible".
- PROPOSED FIX: Let new clients book the free consultation slot directly, or send an instant reply with a booking link and a follow-up.
- OFFER: £240 Booking & Lead Automation Sprint
- EMAIL ANGLE: Keep the consultation step, but let people book it the moment they are interested instead of waiting for a reply. No revenue claims.
- EVIDENCE URL: https://newlifeaesthetics.co.uk/contact/

**4. Vie Aesthetics**
- CLINIC: Vie Aesthetics, Holborn
- CONTACT NAME: Richard Hughes (COO), with Vicky Grammatikopoulou as founder
- EMAIL: RichardH@vie-aesthetics.com (DIRECT, COO)
- SUBJECT: Phone links in your site header
- PERSONALIZATION FACT: Doctor-led clinics in Holborn and Rayleigh, with Pabau booking already in place.
- VERIFIED ISSUE: The London and Rayleigh header links are coded +44 0…, which some phones won't dial as written.
- PROPOSED FIX: Correct both tel: links, tidy the Germany item and add a WhatsApp link for the mobile.
- OFFER: £120 Website Fix Sprint
- EMAIL ANGLE: A small, precise tidy-up of the contact links in the header. Say "some phones", not "doesn't work".
- EVIDENCE URL: https://www.vie-aesthetics.com/

**5. The Bronte Clinic**
- CLINIC: The Bronte Clinic, Cavendish Square
- CONTACT NAME: Dr Fiona McCarthy
- EMAIL: info@thebronteclinic.com (GENERAL)
- SUBJECT: Two small things on your new-address pages
- PERSONALIZATION FACT: The London clinic has just moved to 33 Cavendish Square ("Our London clinic has moved!").
- VERIFIED ISSUE: The postcode appears as "WIG 0PW" across the site, and the privacy policy's only contact email is info@bronte-clinic-old.local.
- PROPOSED FIX: Correct the postcode and the privacy contact, and check the booking form renders after the move.
- OFFER: £120 Website Fix Sprint
- EMAIL ANGLE: Leftovers from the move, pointed out plainly. Don't claim the booking form is broken; that wasn't confirmed.
- EVIDENCE URL: https://thebronteclinic.com/document/privacy-policy/

Signature for the drafts, as you specified:

Joseph Iwe
𝕏 @OsimJoe | 🌐 josephiwe.com

## Files

- This report: /mnt/project-files/outbound-design/round2/round2-report.md
- Table as CSV: /mnt/project-files/outbound-design/round2/round2-prospects.csv
- Per-clinic evidence (page URLs, raw hrefs, company numbers): /mnt/project-files/outbound-design/round2/evidence/batch-A.md to batch-H.md
