# Journey templates for business-facing and platform apps: B2B SaaS (PLG + team expansion), two-sided marketplaces, developer tools / APIs

Scope note: Research done 2026-09-27 using web search and fetches (about 20 tool calls). Every fact below has an inline source. Where I only saw a search-result snippet and could not open the page, the citation says "(snippet)". The journey templates under each "Inferences" heading are my synthesis for Ruah's persona → goal → steps (screen, action, why, signal) format. They are not claims from a source. Each template step points to the findings it rests on.

Source quality legend: **P** = primary (the company or author who produced the data), **S** = secondary summary or aggregator, **V** = vendor benchmark (a sample of the vendor's own customers, so possibly biased toward companies that invest in onboarding).

---

## 1. B2B SaaS / product-led onboarding, including team invites and collaboration expansion

### Takeaway
The standard PLG journey runs signup → workspace setup → first value (activation) → invite teammates → team habit → upgrade or sales-assist. Most signups never reach first value. A 2024 vendor benchmark of 547 SaaS companies put average activation at about 37.5%. Collaboration is the expansion engine, and teams become stable at a small threshold (Slack's atomic network is about 3 users). Sales converts far better when it follows product signals (PQLs, meaning product-qualified leads) than when it chases every signup.

### Cited Findings

**Activation and conversion benchmarks**
- Average user activation rate was 37.5% across 547 SaaS companies. So more than 6 in 10 signups never reach core value. Population: Userpilot customers and respondents, 2024 report (V). — [Userpilot, Product Metrics Benchmark Report 2024](https://userpilot.com/blog/product-metrics-benchmark-report/) (snippet); the report is segmented by company size, vertical and PLG vs SLG (sales-led growth) — [Userpilot, User Activation Rate Benchmark Report 2024](https://userpilot.com/blog/user-activation-rate-benchmark-report-2024/) (snippet; the page returned 404 on fetch)
- Average time to value (TTV) in the same 547-company Userpilot dataset was about 1 day, 12 hours, 23 minutes (V, 2024). — [Userpilot, Time to Value](https://userpilot.com/blog/time-to-value/) (snippet). One snippet also said top-quartile products reach first value in under 5 minutes, but I could not tie that figure to a primary page. Treat it as unverified.
- OpenView benchmarks (OpenView + ProfitWell, 1,000+ SaaS companies per the snippet; around 2022): website-to-signup conversion is about 5% for free trials and about 9% for freemium. Freemium converts to paid at about 2–5% (roughly 5% on average). Trial-to-paid runs about 10–25% without a card and about 40–60% with a card required. — [OpenView 2022 Product Benchmarks](https://openviewpartners.com/2022-product-benchmarks/) (snippet; the page now returns 404); [OpenView, Your Guide to PLG Benchmarks](https://openviewpartners.com/blog/your-guide-to-product-led-growth-benchmarks/) (snippet). Caveat: the card-required figures may come from secondary aggregators quoting OpenView/ProfitWell. Verify before publishing.
- Per the same OpenView snippet, 76% of freemium products measure activation, against 58% of free-trial products. — [OpenView 2022 Product Benchmarks](https://openviewpartners.com/2022-product-benchmarks/) (snippet)
- Also per the OpenView snippet, conversion roughly doubles for free trials and quadruples for freemium when sales contacts more than 50% of signups. This is the evidence for adding a sales-assist step. — [OpenView 2022 Product Benchmarks](https://openviewpartners.com/2022-product-benchmarks/) (snippet)
- Users who complete onboarding retain at 2–3x the rate of those who don't. This is an unattributed claim by the vendor (V). — [Appcues, User onboarding strategies (Lyla Rozelle, 2026-05-26)](https://www.appcues.com/blog/8-user-onboarding-strategies)

**Team invites, collaboration and the atomic network**
- Slack's atomic network is about 3 users. Andrew Chen calls this the smallest stable network that can sustain itself. — [Sachin Rekhi, "A Primer on Network Effects" (review of Chen's *The Cold Start Problem*), 2021-12-07](https://www.sachinrekhi.com/p/andrew-chen-the-cold-start-problem) (S)
- Slack's widely cited activation threshold: teams that exchange about 2,000 messages reach about 93% retention. — reported in summaries of Chen's *The Cold Start Problem* ([Madala book notes](https://dala.medium.com/the-cold-start-problem-how-to-start-and-scale-network-effects-by-andrew-chen-book-notes-part-ii-49b3a4085518); [Zack Liu summary](https://businessbookclub.substack.com/p/free-book-summary-the-cold-start)) (S, snippet). I did not reach the original Slack/Butterfield source.
- Chen's framework has five stages: Cold Start → Tipping Point → Escape Velocity → Ceiling → Moat. The "come for the tool, stay for the network" pattern (Chris Dixon) is the design basis for a useful single-player mode before any invite. — [Rekhi 2021](https://www.sachinrekhi.com/p/andrew-chen-the-cold-start-problem) (S)
- Figma's PQL signal is collaborative. One user exploring says little. Inviting teammates and co-editing the same file is the buying signal. Sharing a file with an outside contractor also spreads the product. — [HowdyGo, PQL guide](https://www.howdygo.com/blog/product-qualified-leads) (S, snippet)
- Slack reportedly tried to get the first user to invite their team within about 72 hours. — [Dock, PQLs](https://www.dock.us/library/product-qualified-leads) (S, snippet). Caution: the same aggregator snippets give a Slack PQL definition ("2+ channels, invite ≥1, 2,000+ messages") that merges the 2,000-message activation stat with PQL criteria. I don't consider it a reliable description of Slack's actual PQL model.
- A PQL is a user or account whose product behaviour shows purchase intent, for example hitting usage limits, inviting teammates, or using premium features during a trial. — [Dock](https://www.dock.us/library/product-qualified-leads) (S, snippet); background on Slack, Atlassian and Zendesk PQL practice: [Decibel VC](https://www.decibel.vc/articles/product-qualified-leads-and-product-led-growth-lessons-from-slack-atlassian-and-zendesk)
- Sources disagree on invite timing:
  - Appcues praises Slack for prompting invites early, because its value grows with each person who joins. — [Appcues 2026](https://www.appcues.com/blog/8-user-onboarding-strategies)
  - An onboarding-framework summary puts team-invite prompts at the start of an "Expand" phase (day 2–30), after the activation event fires. — (snippet from search; the source page was not identified with certainty, so treat it as low confidence)
- Reverse trials: the user starts on a full trial and drops to a free tier after about 14 days (Airtable is the example). Kyle Poyar presents this as combining trial urgency with freemium's ongoing reach. — [Kyle Poyar on X, 2022](https://x.com/poyark/status/1537064035052568578?lang=en) (P)

**Standard layout choices and their why**
- Empty states: fill screens with sample data or templates that show the product in use (Notion is the example), or give an action-led CTA such as "Create your first project". — [Appcues 2026](https://www.appcues.com/blog/8-user-onboarding-strategies) (V)
- Checklists: keep them to 3–5 high-value items. Visible progress (for example 3 of 5 done) motivates users to finish. — [Appcues 2026](https://www.appcues.com/blog/8-user-onboarding-strategies) (V; the psychology claim is not sourced)

### Inferences

**Personas**
| Persona | Goal | Notes |
|---|---|---|
| Admin / buyer (often the first signup) | Show the tool solves a team problem and justify the spend | Owns workspace setup, billing and SSO; the likely PQL/sales-assist contact |
| End user (first individual user) | Get their own job done faster | Must reach first value in single-player mode ("come for the tool") |
| Invited teammate | Understand why they were invited and contribute fast | Arrives in the middle of a flow via a link; needs context, not the full onboarding |
| (Optional) Economic approver / IT or security | Approve spend and security | Shows up at upgrade, SSO or SCIM, or procurement |

**Core journeys (template steps: screen → action → why → signal)**
1. *Signup → workspace setup*
   - Signup (SSO/Google) → create account → less friction; work email captures company domain for account-level grouping → signup completed.
   - Workspace naming / role question → pick use case → personalise templates and sample data → answered.
2. *First value (activation)*
   - Pre-filled template or sample data → edit or run one core action → an empty canvas stalls users (Appcues) → activation event (product-specific; Userpilot's ~37.5% average is the baseline to beat).
   - Checklist of 3–5 steps → complete them → progress motivation → checklist completion.
3. *Invite teammates (collaboration expansion)*
   - Invite prompt shown in context after the first artifact exists ("share this doc", "assign this issue") → invite by email, link or domain auto-join → the invitee lands on something real, and the network needs about 3 people to be stable (Slack/Chen) → invites sent, invite acceptance rate, time to 3 active users.
   - Invited teammate lands on the shared object, not a blank home → comment or edit → gets value from the first click → teammate activation.
4. *Team habit → upgrade*
   - Usage limit or paywall on a collaborative or admin feature → upgrade or start trial → the upgrade is tied to value already received → trial start, paywall conversion.
5. *Sales-assist handoff*
   - The account crosses PQL thresholds (seats, invites, limits hit, pricing page viewed) → a human reaches out → OpenView reports much higher conversion when sales touches signups → PQL-to-opportunity and win rate.
6. *Admin hardening* (optional)
   - Settings → SSO, SCIM, roles, audit log → needed for company-wide rollout → security review passed, seat expansion.

**Why the invite prompt comes after first value (synthesis)**
Asking before value means the invitee joins an empty workspace. That weakens the invite and the invitee's first impression. Asking right after the first artifact gives a concrete reason to share. For products with no single-player value (chat, for example), an early invite is right, which is why Slack is praised for inviting early. Rule for templates: *invite as soon as there is something worth sharing; if the product has no single-player value, that point is at signup.*

**Activation: account level vs user level**
Track both:
- User activation: the individual did the core action.
- Account (team) activation: N active users plus a collaborative action, for example about 3 users on Slack or co-editing on Figma.

Account-level activation is the better PQL and retention predictor for collaborative products. This is inferred from the Slack and Figma examples.

**Drop-off points (where to instrument)**
- Signup form.
- Setup and questionnaire (too many questions).
- Empty state (no first action).
- Invite step (skipped).
- Invitee acceptance.
- Trial end or paywall.

The only data I found is the aggregate activation gap (about 62% never activate, Userpilot 2024) and the 2–5% freemium conversion rate (OpenView). I found no published per-step drop-off data.

**Signals**
signup→activation rate · time to value · checklist completion · invites per account · invite acceptance rate · accounts reaching the atomic-network threshold (for example ≥3 active users) · PQL rate · free→paid / trial→paid conversion · seat expansion / net dollar retention.

### Gaps
- The primary OpenView 2022/2023 benchmark pages returned 404. The numbers above come from search snippets and could not be checked against the full report or its sample definition.
- I found no primary, dated source for Slack's 2,000-message / 93% retention stat (only book summaries), and no primary Figma, Notion or Linear case study with invite-timing data.
- I found no published per-step drop-off funnel for B2B onboarding (for example the % who abandon at the invite step).
- The Wes Bush / ProductLed "bowling alley" framework and Pendo data were not fetched within the call budget.
- The claim "team products retain ~80% vs single-player 40–60%" appeared in a search summary attributed loosely to Kyle Poyar. I could not verify it; the Appcues page I checked did not contain it. Excluded.

---

## 2. Two-sided marketplaces (supply side, demand side, ops / trust & safety)

### Takeaway
Most successful marketplaces started out supply-constrained and grew supply first. In Lenny Rachitsky's study, 14 of 17 did. They used direct sales as the main lever and focused on a narrow atomic network, such as one city or category. Health is measured by liquidity (match rate, time to match, market depth), repeat and cohort retention, and concentration (a16z's 13 metrics).

### Cited Findings

**Supply-first vs demand-first**
- 80% of the successful marketplaces studied (14 of 17) focused on growing supply first. The three demand-constrained exceptions were Rover, TaskRabbit and Zillow. — [Lenny Rachitsky, "How to Kickstart and Scale a Marketplace Business – Part 2: Supply vs. Demand", 2019-11-22](https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-9ee) (P; population = 17 large consumer marketplaces interviewed by the author)
- Why supply first: good supply attracts demand. Eventbrite organisers bring attendees, DoorDash restaurants bring their existing fans, and on Etsy the early sellers were also buyers. — [Rachitsky Part 2, 2019](https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-9ee)
- Demand-first exceptions:
  - Rover: supply was easy because dog lovers wanted flexible income, and demand needed behaviour change.
  - TaskRabbit: thousands of workers were waiting.
  - Zillow: seeded "supply" from public data to attract demand.
  - Source: [Rachitsky Part 2, 2019](https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-9ee)
- Rachitsky's view: every marketplace starts supply-constrained, because you first need something to sell. — [Rachitsky on X, 2019](https://twitter.com/lennysan/status/1167088120132562945) (snippet)

**How initial supply was acquired**
- Direct sales was used by about 60% of the studied marketplaces: Airbnb, OpenTable, Etsy, Caviar, Uber, DoorDash, AngelList. — [Rachitsky, Part 3: Growing Initial Supply, 2019-11-25](https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-911)
- Other levers:
  - Referral programs (~33%: Lyft, Uber, Caviar, DoorDash).
  - Piggybacking on existing networks (~33%, e.g. Uber via Craigslist).
  - Word of mouth (~25%).
  - Subsidies (~25%: Uber, Lyft, Breather, Zillow).
  - Less common: employees as supply (Rover, TaskRabbit, DoorDash), single-player mode (OpenTable, Eventbrite, Patreon), performance marketing, viral loops, events, SEO, community.
  - Source: [Rachitsky Part 3, 2019](https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-911)
- The median marketplace succeeded with just 2 supply levers (average 2.5). The advice is to concentrate rather than spread effort. — [Rachitsky Part 3, 2019](https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-911)
- Airbnb used local teams accountable for specific markets, tailoring by neighbourhood, listing type and price. This is geographic focus in practice. — [Rachitsky Part 3, 2019](https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-911)
- GrubHub (per Casey Winters) grew supply almost entirely through in-person sales, visiting restaurants during quiet hours. Marketplaces removed supplier objections: pay only on orders, no hidden fees, cancel anytime. — [Lenny's Newsletter, labor/supply growth](https://www.lennysnewsletter.com/p/labor-marketplace-supply-growth) (snippet); see also [Rachitsky on andrewchen.com, "28 ways to grow supply in a marketplace"](https://andrewchen.com/grow-marketplace-supply/)

**Atomic network and the hard side**
- Chen's atomic network examples: Airbnb needed hundreds of active listings per market, and Uber went city by city. The work is to find the "hard side" of the network and solve a hard problem for it. — [Rekhi review of *The Cold Start Problem*, 2021-12-07](https://www.sachinrekhi.com/p/andrew-chen-the-cold-start-problem) (S)
- Invite-only launches (Gmail, Facebook, LinkedIn) created network density and better onboarding through existing connections. — [Rekhi 2021](https://www.sachinrekhi.com/p/andrew-chen-the-cold-start-problem) (S)

**Metrics (a16z)**
a16z's 13 marketplace metrics are:
1. Match rate
2. Market depth
3. Time to match
4. Concentration/fragmentation (% of GMV from the top X sellers or buyers)
5. Take rate
6. Unit economics
7. Multi-tenanting
8. Switching/multi-homing costs
9. User retention cohorts (newer cohorts should retain better as the network matures)
10. Core-action retention
11. Dollar retention
12. Retention by geography
13. Power-user curves

Source: [Jeff Jordan, Li Jin, D'Arcy Coolican, Andrew Chen, "13 Metrics for Marketplace Companies", a16z, 2020-02-21](https://a16z.com/13-metrics-for-marketplace-companies/) (P)

- a16z advises watching "zeros" (searches or requests with no match), finding why matches fail, and fixing them through incentives on the constrained side and product design. Match rate usually climbs over longer windows as more inventory clears. — [a16z 2020](https://a16z.com/13-metrics-for-marketplace-companies/); definitions in [a16z Marketplace Glossary](https://a16z.com/the-marketplace-glossary/)
- Lenny also has a separate write-up of the most important marketplace metrics. — [Lenny's Newsletter](https://www.lennysnewsletter.com/p/the-most-important-marketplace-metrics) (not fetched)

### Inferences

**Personas**
| Persona | Goal |
|---|---|
| Supplier / seller / provider (the usual "hard side") | Earn income or reach customers with little setup and risk |
| Buyer / demand-side customer | Find a trustworthy match fast and transact safely |
| Ops / trust & safety / marketplace admin | Keep liquidity and quality high and fraud low; approve, moderate and resolve disputes |
| (Optional) Repeat buyer / power supplier | Transact again with less friction; grow the business on the platform |

**Core journeys**
1. *Supply onboarding → first listing live*
   - Landing page for suppliers (earnings calculator, "no fee until you earn") → start application → removes risk objections (Rachitsky Part 3) → application started.
   - Profile / verification (ID, payout details) → submit → needed for trust, but it is the biggest friction point, so defer non-essential fields → verification completed.
   - Listing builder (photos, price, availability) with templates or pricing suggestions → publish → a live listing is supply's activation → time to first listing live.
   - Ops review queue (ops persona) → approve or reject → quality gate → approval time.
2. *Supply first sale / earnings*
   - Dashboard "your first booking" → accept or fulfil → first earnings drive supplier retention → time to first transaction for new suppliers.
3. *Demand: search → match → book/buy*
   - Home/search with location or category prefilled → search → keep users inside a dense atomic network (city/category) → searches with ≥1 result (inverse of a16z's "zeros").
   - Results with trust signals (reviews, badges, price) → open listing → trust is required before paying → listing view → checkout rate.
   - Checkout → pay or book → escrow or platform payment protects both sides → match rate / conversion; time to match.
4. *Post-transaction: review → repeat*
   - Review prompt after fulfilment (both sides) → rate → builds the reputation layer → review submission rate.
   - Rebook / reorder shortcut → repeat purchase → repeat rate is the key health signal → repeat and cohort retention (a16z).
5. *Trust & safety / dispute*
   - Report issue / help centre → file a dispute → ops mediates → resolution time, dispute rate, refund rate.
6. *Ops: liquidity management*
   - Ops dashboard of zero-result searches and unfilled requests by geography → recruit supply or adjust incentives → a16z's "zeros" plus retention by geography → match rate by market.

**Why the standard layout exists (synthesis)**
- Supply-side screens stress earnings and zero upfront risk because supply is usually the constrained side (14 of 17 marketplaces).
- Search is geo- or category-scoped because liquidity is local (atomic network, retention by geography).
- Reviews and verification sit on the listing page because the buyer must trust a stranger.
- Payment goes through the platform because it anchors trust and the take rate.

**Drop-off points**
- Supplier application/verification.
- Draft listing never published.
- Buyer search with no or poor results ("zeros").
- Checkout.
- First-transaction quality (bad first experience → no repeat).

Published per-step numbers were not found. a16z only names the zeros and match-rate lens.

**Signals**
supplier activation (first listing live, first sale) · market depth per geo/category · match (fill) rate · time to match · search→transaction conversion · repeat rate and cohort retention (newer cohorts ≥ older) · GMV concentration among top suppliers · take rate · dispute/refund rate.

### Gaps
- I found no published quantitative drop-off data for supplier onboarding (for example % of started Airbnb host listings that go live) or for buyer checkout in a specific marketplace.
- Etsy, Uber and Airbnb primary case studies and NFX marketplace guides were not fetched within the call budget.
- Rachitsky's sample (17 large consumer marketplaces, 2019) is biased toward survivors, and B2B or services marketplaces may differ.
- Trust & safety benchmarks (for example the effect of double-blind reviews on review honesty) were not researched.

---

## 3. Developer tools / API products

### Takeaway
The developer journey is discover/docs → sign up and get a key → first successful call ("hello world") in a sandbox or test mode → working app in production → team, billing and expansion. The standard north-star onboarding metric is time to first call / first hello world. Postman's measurements show ready-to-run examples cut it by 1.7x–56x. Stripe-style practices (test mode, test keys injected into docs, request logs, CLI) exist to shrink that gap. Missing documentation is repeatedly the top obstacle developers report.

### Cited Findings

**Time to first call / hello world**
- Postman calls time to first call (TTFC) the most important metric for a public API. It is the time from discovery to the first successful request, which Postman describes as the developer's first payoff. — [Joyce Lin, Postman, "The Most Important API Metric Is Time to First Call", 2021-07-22](https://blog.postman.com/the-most-important-api-metric-is-time-to-first-call/) (P); also carried by [TechCrunch 2021-07-12](https://techcrunch.com/2021/07/12/the-most-important-api-metric-is-time-to-first-call/)
- Postman's developer journey stages: Browse → Sign-up → First API call → Implementation → Usage. — [Postman 2021](https://blog.postman.com/the-most-important-api-metric-is-time-to-first-call/)
- Postman's experiment: API publishers compared TTFC with and without a ready-to-run Postman Collection. Company A went from 17 minutes to 10 minutes (1.7x). Across the sampled APIs, improvements ranged from 1.7x to 56x. Recommended assets: executable collections, environments with auth and config variables, explicit auth guidance, copy-paste code generation. — [Joyce Lin, Postman, "Improve Your Time to First API Call by 20x", 2023-04-04](https://blog.postman.com/improve-your-time-to-first-api-call-by-20x/) (P; sample = a small number of API publishers, exact count not given). A snippet says PayPal cut TTFC from hours to one minute, but this was not visible on the fetched page. Treat it as unverified.
- Moesif's API funnel has three stages. It adds TTFWA/TTFPA (first working app / first paid app), API MAU/DAU, 28-day active companies and distinct operations used as production metrics. Named obstacles are integration errors, unclear value, priority conflicts and compliance delays; there are no percentages.
  1. Pre-integration (API key creation, config download).
  2. Sandbox (first successful call; TTFHW = time to first hello world is the key KPI).
  3. Production (measurable live traffic).
  - Source: [Derric Gilling, Moesif, "Mastering API Analytics… The Developer Funnel", 2022-10-19](https://www.moesif.com/blog/technical/api-analytics/Mastering-API-Analytics-for-API-Programs-Chapter-1/) (V)

**Documentation as the top blocker**
- In Postman's 2020 State of the API survey, lack of documentation was the number one obstacle to consuming APIs (54.3%). — [HackerNoon summary of the Postman 2020 report](https://hackernoon.com/54percent-of-developers-cite-lack-of-documentation-as-the-top-obstacle-to-consuming-apis-2v4w3e30) (S)
- It stayed the top obstacle in 2023; one secondary snippet puts it at 52%. — search snippet (S; exact 2023 % unverified). Postman's report archive: [Postman State of the API](https://www.postman.com/state-of-api/executing-on-apis/); 2025 report PDF: [Postman 2025](https://voyager.postman.com/doc/postman-state-of-the-api-report-2025.pdf) (not fetched)

**Stripe-style developer experience**
- Stripe's test mode lets developers integrate without touching real data or moving real money. Every request is logged in the dashboard, so developers can inspect it and learn how objects relate. Interactive integration builders pair explanations with working sample code. The CLI and VS Code extension test webhooks and generate code inside the developer's own tools. "Friction logging" means dogfooding new features and recording the pain points. Naming stays consistent across REST, SDKs and framework libraries. — [Kenneth Auchenberg (ex-Stripe), "Insights from building Stripe's developer platform…", Part 1, ~Apr 2024](https://kenneth.io/post/insights-from-building-stripes-developer-platform-and-api-developer-experience-part-1) (P, practitioner)
- When a developer is logged in, Stripe docs insert their test API keys into code samples, and many endpoints can be run from the docs page. Keys are separated by prefix (pk_test/sk_test vs pk_live/sk_live), and restricted keys limit the damage if a key leaks. — [Moesif Stripe DX teardown](https://www.moesif.com/blog/best-practices/api-product-management/the-stripe-developer-experience-and-docs-teardown/) (S, snippet); [Stripe Sandboxes blog](https://stripe.dev/blog/avoiding-test-mode-tangles-with-stripe-sandboxes) (P, not fetched)
- Heavybit recommends a Getting Started page, a quick start guide and "hello world" code samples to shorten ramp-up. It also hosts talks on developer onboarding ("Breadcrumbs and Carrots"). — [Heavybit DevGuild: Developer Experience](http://devguild.heavybit.com/developer-experience/) (snippet); [Heavybit, Breadcrumbs and Carrots](https://www.heavybit.com/library/video/breadcrumbs-and-carrots-optimizing-developer-onboarding) (not fetched)

**Dev-tool product benchmarks**
- boldstart ventures published product benchmarks for dev tools in 2023. — [Anna Debenham, boldstart, "Product benchmarks for dev tools in 2023"](https://medium.com/boldstart-ventures/so-what-does-good-look-like-product-benchmarks-for-dev-tools-in-2023-c41884c2b388) (not fetched; worth pulling)

### Inferences

**Personas**
| Persona | Goal |
|---|---|
| Individual developer (evaluator/builder) | Get a working call or integration fast with no sales contact |
| Team lead / engineering manager | Standardise on the tool, manage keys, environments and cost for the team |
| Platform / security reviewer | Approve for production: auth model, key scoping, compliance, data handling |
| (Optional) Billing owner / procurement | Predictable pricing, invoices, usage limits |

**Core journeys**
1. *Docs → sign up → API key*
   - Docs home / quickstart (public, no login wall) → read quickstart → developers judge the product by its docs, and missing docs is the top blocker (Postman) → quickstart page views → signup.
   - Signup (GitHub/Google OAuth) → create account → less friction → signup.
   - Dashboard showing a test key immediately → copy the key → test keys separate from live keys keep exploring safe (Stripe) → key created.
2. *First successful call (hello world)*
   - Quickstart with the key pre-filled, a copy-paste curl/SDK snippet, a "Run in Postman" / try-it console, or a CLI → run the call → ready-to-run examples cut TTFC 1.7x–56x (Postman) → first 2xx call; TTFC/TTFHW.
   - Request log in the dashboard → inspect request and response → teaches the object model and aids debugging (Stripe) → log viewed; error→retry success.
3. *Integrate into a real app*
   - Sample apps, SDKs, integration builder, webhooks with local CLI forwarding → build the feature → bridges hello world to a working app (Moesif TTFWA) → webhook configured; time to first working app.
4. *Go live / production*
   - Activation checklist (verify account, live keys, restricted keys, domain) → switch to live → security and compliance gate → first live call; time to first paid app.
   - Security/platform review (reviewer persona): security docs, SOC 2, scopes, audit logs → approve → blocker named by Moesif (compliance delays) → approval time.
5. *Team and billing expansion*
   - Team settings → invite developers, set roles, per-environment keys → multiple developers per account predicts stickiness (inferred by analogy with B2B collaboration) → active developers per account.
   - Usage and billing page → set plan or limits → predictable cost → plan upgrade; 28-day active companies and distinct operations (Moesif).

**Why the standard layout exists (synthesis)**
- Docs are public and the landing page effectively is the docs, because developers evaluate by reading.
- Test mode and test keys appear before any payment or KYC, so the first call can happen in minutes.
- Keys are auto-injected so copy-paste works first time.
- The request log is visible because errors are the main drop-off and debugging is how developers learn.
- Going live is a separate, deliberate step because production brings security review and money.

**Drop-off points**
- Docs don't answer the first question (Postman's top obstacle).
- Signup wall before docs.
- Auth or key setup errors.
- First call fails (4xx) with no clear error message.
- Stall between sandbox and production (priority conflicts, compliance; Moesif).
- Only Postman's TTFC timings (17→10 min for one company) and the documentation-obstacle survey numbers are published. I found no funnel percentages.

**Signals**
TTFC/TTFHW (median minutes) · % of signups making a successful call within 1 day · first-call error rate · time to first working app / first live call · % reaching production traffic · weekly or 28-day active API keys or companies · distinct endpoints/operations used · developers per account · paid conversion.

### Gaps
- I found no published per-step developer funnel percentages (for example % of signups who ever make a call). Postman's 20x study covers only a few publishers with no population detail.
- The exact 2023–2025 Postman "lack of documentation" percentages were not verified from the report PDFs.
- Twilio's "Ask Your Developer" (Jeff Lawson) and Heavybit's DevGTM library were not fetched. Their positions (developer-first, bottom-up adoption) appear here only indirectly.
- The boldstart dev-tool benchmarks (2023) were not opened. They may have activation and conversion figures specific to dev tools.
