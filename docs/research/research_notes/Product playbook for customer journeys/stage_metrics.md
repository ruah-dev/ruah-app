# Success metrics and benchmark ranges per customer-journey stage

Scope: example "signals" (success metrics) for each journey stage (acquisition, activation, engagement, retention, referral, revenue) plus PMF signals, with definitions and published benchmark ranges. Context: feeds Ruah's "suggest a signal / flag journeys with no signal" feature. Research date: 2026-09-27.

Source-quality legend used below: **[P]** = primary source (the publisher of the data), **[A]** = aggregator / secondary summary (primary not fetched; treat numbers as indicative).

---

## 1. Frameworks: AARRR pirate metrics and the North Star metric

### Takeaway
AARRR (Acquisition, Activation, Retention, Referral, Revenue) is the common stage skeleton; modern practice layers a single North Star Metric (NSM) plus 3–5 input metrics on top so each stage's signal ladders up to one value-based outcome. For Ruah, AARRR maps naturally to journey stages, and the NSM/input split maps to "journey-level signal" vs "step-level signal".

### Cited Findings
- Amplitude's North Star Playbook: every product should anchor on one North Star Metric that captures the core value delivered to users; product work is structured to move it — [Amplitude North Star Playbook (PDF)](https://info.amplitude.com/rs/138-CDN-550/images/Amplitude-The-North-Star-Playbook.pdf) [P]
- Inputs are 3–5 complementary factors the team believes most directly drive the NSM and can directly influence; each input should have a name and a definition — [Amplitude, North Star Playbook: metric and inputs](https://amplitude.com/books/north-star/amplitudes-north-star-metric-and-inputs) [P]
- A good NSM correlates with a top-level business outcome, but teams are better served moving a leading-indicator component that ladders up to it — [Amplitude blog: good vs bad North Star metric](https://amplitude.com/blog/good-bad-north-star-metric) [P]
- YC/Paul Graham growth guidance (2012 essay "Startup = Growth"): a good growth rate during YC is 5–7% per week; 10%/week is exceptional; 1%/week signals the team hasn't figured things out; revenue is the best thing to measure growth on (if no revenue, active users). 1%/week ≈ 1.7x/yr, 5%/week ≈ 12.6x/yr — [YC Startup Library: Startup = growth](https://www.ycombinator.com/library/8s-startup-growth) [P]
- Critique: weekly-growth targets during YC can be a "false signal" when growth is manufactured for Demo Day — [TechCrunch, 2016](https://techcrunch.com/2016/12/18/growth-as-a-false-signal-in-y-combinator-startups/) [P, opinion]

### Inferences
- A Ruah journey could carry one NSM-style signal at the journey level and stage-specific input signals per step; a journey with only output metrics (revenue) and no leading-indicator step signals is a reasonable thing to flag.
- The 5–7%/week figure is an early-stage (pre-scale, YC-batch) benchmark for revenue or active users, not a mature-company benchmark; the tool should label it that way.

### Gaps
- I did not fetch Dave McClure's original 2007 "Startup Metrics for Pirates" deck; AARRR attribution here is from common knowledge, not a fetched primary source.

---

## 2. Acquisition (top-of-funnel and funnel-level conversion)

### Takeaway
Acquisition signals are conversion rates at each funnel hop (visit → signup, landing page → lead) plus channel efficiency (CAC). Published medians are low single digits to ~7% for landing pages, with large variance by industry and traffic source.

### Metrics table

| Metric | Definition | Example | Benchmark range | Source + date |
|---|---|---|---|---|
| Landing-page conversion rate | Conversions (form fill/signup/purchase) ÷ unique visitors to the page | Pricing page → "Start trial" click | Median 6.6% across industries; SaaS lowest at ~3.8%, Events & Entertainment highest at ~12.3% | Unbounce Conversion Benchmark Report (41,000 pages, 464M visits) — [Unbounce](https://unbounce.com/landing-pages/whats-a-good-conversion-rate/) [P]; report period circa 2024 (Q4 2024 data page: [Unbounce](https://unbounce.com/average-conversion-rates-landing-pages/)) |
| Conversion by traffic source | Landing-page conversion segmented by channel | Email vs paid search | Email ~19.3%, paid social ~12%, paid search ~10.9%, display ~4.1% (medians) | Unbounce benchmark (as summarized in search results; same report) — [Unbounce](https://unbounce.com/landing-pages/whats-a-good-conversion-rate/) [P, via snippet] |
| Visitor-to-signup (freemium vs trial) | Signups ÷ website visitors | Homepage visit → account created | Freemium ~6% vs free trial ~3–4% | Lenny Rachitsky × Kyle Poyar/OpenView free-to-paid survey (~2023, 1,000+ products), as summarized — [Lenny's Newsletter](https://www.lennysnewsletter.com/p/what-is-a-good-free-to-paid-conversion) [A — figure from aggregator summary, verify in post] |
| Checkout / cart abandonment (e-commerce) | 1 − (completed orders ÷ carts created) | Cart → purchase | Average 70.22% abandonment (average of 50 studies); mobile ~80.0% vs desktop ~66.4%; better checkout design could lift conversion ~35% for large sites | Baymard Institute, updated 22 Sep 2025 — [Baymard](https://baymard.com/lists/cart-abandonment-rate) [P] |
| CAC / payback | Sales+marketing spend ÷ new customers; months of gross margin to recover CAC | — | Not researched in depth here | — |

### Inferences
- Signup-form conversion and landing-page conversion should be expressed as a funnel-step signal on the step that has the form; Ruah can suggest "X% of visitors reach step N+1" as a default acquisition signal.
- Baymard's ~70% is an abandonment rate (inverse framing); tools should be careful to label direction so a "good" value is clear.

### Gaps
- No primary benchmark found for signup-form completion rate specifically (form start → submit). Would need Zuko/Formisimo-style form analytics reports.
- CAC and CAC-payback benchmarks (e.g., KeyBanc/OpenView SaaS surveys) not collected.

---

## 3. Activation (aha moment, time-to-value, onboarding completion)

### Takeaway
Activation = share of new signups who reach a defined "first value" action within a time window. Survey benchmarks: average ~34% / median ~25% overall (SaaS: avg ~36%, median ~30%). The famous "magic numbers" (Facebook 7 friends in 10 days, Slack 2,000 messages) are best understood as rallying devices derived from correlation, not proven causal thresholds.

### Metrics table

| Metric | Definition | Example | Benchmark range | Source + date |
|---|---|---|---|---|
| Activation rate | % of new signups who complete the activation event (the earliest action that predicts long-term retention) within a set window | % of new users who create a project and invite a teammate within 7 days | All products: average 34%, median 25%. SaaS only (excl. marketplaces, e-com, DTC): average 36%, median 30%. 60th percentile = "good", 80th = "great" | Lenny Rachitsky & Yuriy Timen survey, 500+ responses, published Oct/Nov 2022 — [Lenny's Newsletter](https://www.lennysnewsletter.com/p/what-is-a-good-activation-rate); [Lenny on X](https://x.com/lennysan/status/1584923800226832384?lang=en) [P] |
| Time-to-value (TTV) | Median elapsed time from signup to first value / activation event | Minutes from signup to first dashboard rendered with real data | Average TTV ~1 day 12 hours across 547 SaaS companies | Userpilot TTV Benchmark Report 2024 — [Userpilot](https://userpilot.com/blog/time-to-value-benchmark-report-2024/) [P, via snippet] |
| Onboarding checklist completion | % of users who start an onboarding checklist and complete all items | Complete 5-step setup checklist | Average 19.2%, median 10.1%; FinTech & Insurance highest (24.5%), MarTech lowest (12.5%); sales-led 22.1% vs product-led 19%; $1–5M revenue companies highest (27.5%) | Userpilot Onboarding Checklist Completion Benchmark 2024 — [Userpilot (Medium)](https://userpilot.medium.com/customer-onboarding-checklist-completion-rate-2024-benchmark-report-8ebabebefb1f); 2025 update exists: [Userpilot 2025](https://userpilot.com/blog/onboarding-checklist-completion-rate-benchmarks/) [P] |
| Aha-moment / "magic number" | A threshold of an early action (N actions in T days) above which retention is markedly higher | Facebook: 7 friends in 10 days; Slack: team has exchanged 2,000 messages | N/A — company-specific; derived via correlation of early behaviors with later retention | See findings below |
| First-session meaningful action (mobile) | % of Day-0 installers completing a core first action | — | Apps that nail first-session activation retain at 2–3x the rate of those that don't (claim) | UXCam 2026 retention benchmarks — [UXCam](https://uxcam.com/blog/mobile-app-retention-benchmarks/) [A — methodology unclear] |

### Cited Findings (aha moment method and caveats)
- Mixpanel ("Magic numbers are an illusion", Mixpanel Team, dated 2 Jun 2026 on page): searching data for a single retention-predicting metric usually reveals messy, multi-factor relationships; the famous numbers are useful storytelling/alignment devices, not precise formulas. It cites Andrew Chen's view that Facebook's metric could just as well have been "10 friends in 12 days" or "5 friends in 1 day" — [Mixpanel](https://mixpanel.com/blog/magic-numbers-are-an-illusion/) [P, opinion]
- Aha moments blend different experiences into one number, are often round numbers picked from a range, and should not be read as scientific tipping points; correlation is the starting point, not proof of causation — [Mixpanel](https://mixpanel.com/blog/magic-numbers-are-an-illusion/); similar argument in [Mode: Facebook's aha moment was simpler than you think](https://mode.com/blog/facebook-aha-moment-simpler-than-you-think/) [P, opinion]
- Userpilot activation-rate report 2024 exists ([Userpilot](https://userpilot.com/blog/user-activation-rate-benchmark-report-2024/)) but the page returned 404 when fetched; numbers not verified.

### Inferences
- Recommended activation-discovery method for Ruah's playbook: (1) list candidate early actions; (2) compare Day-N retention of users who did vs didn't do each action within T days; (3) pick the action/threshold with the best balance of coverage and retention lift; (4) validate with an experiment that pushes users to the action (causation check). This is the standard practitioner method implied by the sources above.
- The Facebook/Slack/Dropbox numbers should be presented in the tool as illustrative, with a "contested / correlational" caveat.
- Because medians sit at ~25–30%, a Ruah default suggestion like "activation ≥ 30% (SaaS median, 2022)" and "≥ 40–50% is strong" is defensible if labeled with source/date.

### Gaps
- Primary sources for Slack's "2,000 messages" (attributed to Stewart Butterfield, ~2014–15) and Dropbox's "one file in one folder on one device" were not fetched; the Dropbox one in particular is widely repeated without a clear primary source — treat as apocryphal until verified.
- Amplitude, Pendo, and OpenView product benchmark reports on activation were not fetched in this pass.
- No reliable cross-industry benchmark for TTV beyond Userpilot's single figure.

---

## 4. Core action / engagement

### Takeaway
Engagement signals measure repeat use of the core action: DAU/MAU (stickiness), core actions per active user, and L7/L28 frequency. Mixpanel's 2026 benchmarks put B2B SaaS DAU/MAU at ~31%, well below the oft-quoted 40–50% "great" rule of thumb.

### Metrics table

| Metric | Definition | Example | Benchmark range | Source + date |
|---|---|---|---|---|
| DAU/MAU (stickiness) | Average daily actives ÷ monthly actives × 100 | 3,100 DAU ÷ 10,000 MAU = 31% | B2B SaaS ~31% (N. America & EMEA), APAC ~33%; e-commerce ~20%; North America AI products ~21%; LATAM fintech wealth mgmt ~38%. 25–35% ≈ in line for B2B SaaS | Mixpanel State of Digital Analytics / Product Benchmarks 2026 (12,000+ companies) — [Mixpanel benchmarks](https://mixpanel.com/benchmarks/); [Mixpanel MAU post](https://mixpanel.com/blog/mau/) [P, figures via search snippet] |
| Core actions per active user | Count of the value-defining action ÷ active users per period | Docs created per weekly active user | Product-specific; no universal benchmark | — |
| North Star metric | One value-capturing metric (often a core-action count), e.g., "weekly active teams doing X" | — | N/A (company-specific) | [Amplitude North Star Playbook](https://amplitude.com/resources/north-star-playbook) [P] |

### Inferences
- Low DAU/MAU is not always bad: Mixpanel notes AI/enterprise users may accomplish more per session and return less often. Ruah should suggest a frequency window matching the product's natural cadence (daily vs weekly vs monthly) rather than always DAU/MAU.

### Gaps
- Pendo/Amplitude product-benchmark engagement figures (e.g., feature adoption rates) not collected.

---

## 5. Retention

### Takeaway
Retention is widely considered the most important growth metric; a cohort curve that flattens (rather than decaying to zero) is the core retention-based PMF signal. Benchmarks vary hugely by model: 6-month user retention "good" ranges from ~25% (consumer social) to ~70% (enterprise SaaS); consumer mobile apps retain ~25% D1, ~11–13% D7, ~5–7% D30; private B2B SaaS median NRR 101% / GRR 91% (2025).

### Metrics table

| Metric | Definition | Example | Benchmark range | Source + date |
|---|---|---|---|---|
| 6-month user retention (cohort) | % of a signup cohort still active in month 6 | — | GOOD / GREAT: Consumer social ~25% / ~45%; Consumer transactional ~30% / ~50%; Consumer SaaS ~40% / ~70%; SMB/Mid-market SaaS ~60% / ~80%; Enterprise SaaS ~70% / ~90% | Lenny Rachitsky, "What is good retention", 9 Jun 2020 (20 growth practitioners) — [Lenny's Newsletter](https://www.lennysnewsletter.com/p/what-is-good-retention-issue-29) [P; note pre-2022] |
| Net revenue retention (12-mo) | (Starting MRR + expansion − contraction − churn) ÷ starting MRR for a cohort | — | GOOD / GREAT: Consumer SaaS ~55% / ~80%; Bottom-up SaaS ~100% / ~120%; VSB land-and-expand ~80% / ~100%; SMB/Mid-market ~90% / ~110%; Enterprise ~110% / ~130% | Same Lenny post, Jun 2020 — [Lenny's Newsletter](https://www.lennysnewsletter.com/p/what-is-good-retention-issue-29) [P] |
| NRR / GRR, private B2B SaaS | As above; GRR excludes expansion | — | 2025 medians: NRR 101%, GRR 91%. Bootstrapped: NRR 104% / GRR 92%; equity-backed: NRR 101% / GRR 90%. GRR ≥ 90% described as "table stakes"; higher ACV → higher retention; NRR correlates with growth | SaaS Capital 2025 B2B SaaS Retention Benchmarks (14th annual survey, companies > $1M ARR) — [SaaS Capital blog](https://www.saas-capital.com/blog-posts/what-is-a-good-retention-rate-for-a-private-saas-company/); [PDF](https://www.saas-capital.com/wp-content/uploads/2025/09/RB32WS1-2025-B2B-SaaS-Retention-Benchmarks.pdf) [P] |
| Monthly churn (logo/customer) | Customers lost in month ÷ customers at start of month | — | GOOD / GREAT: B2B SMB+Mid-market 2.5–5% / < 1.5%; B2B Enterprise 1–2% / < 0.5%; B2C SaaS 3–5% / < 2% | Lenny Rachitsky with ProfitWell data (13,000 SaaS cos), Feb 2022 — [Lenny's Newsletter](https://www.lennysnewsletter.com/p/monthly-churn-benchmarks) [P] |
| Mobile app D1 / D7 / D30 retention | % of installers who open the app on day 1 / 7 / 30 | — | Cross-industry ≈ 25–26% D1, 11–13% D7, 5–7% D30; D30 by category: social 15–20% (strong), e-com 3–6%, fintech 10–15%, gaming 4–8%, productivity 10–18%; education D1 ~14–15%, D30 ~2–3% | UXCam, "Mobile App Retention Benchmarks by Industry (2026)" — [UXCam](https://uxcam.com/blog/mobile-app-retention-benchmarks/) [A — aggregates Adjust/AppsFlyer-type data; primary not fetched] |
| Subscriber retention (consumer subscription apps) | % of paying subscribers still subscribed after 12 months | — | 12-mo retention: hard paywall ~27%, freemium ~28%; annual plans lose ~72% within year 1 in 2026 data (vs ~56% in 2025 report); 35% of annual cancellations happen in month 1; AI monthly plans retain ~36% worse than non-AI | RevenueCat State of Subscription Apps 2026 (115,000+ apps, $16B revenue), published 19 Mar 2026 — [RevenueCat](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026) [P] |

### Cited Findings
- Lenny's retention benchmarks note that ad-supported free products typically retain lower than subscriptions, and lower retention may be acceptable with low CAC or non-venture models — [Lenny's Newsletter, 2020](https://www.lennysnewsletter.com/p/what-is-good-retention-issue-29) [P]
- Growth rate is positively (exponentially) correlated with NRR; median growth rate in the SaaS Capital sample was 24% — [SaaS Capital, 2025](https://www.saas-capital.com/blog-posts/what-is-a-good-retention-rate-for-a-private-saas-company/) [P]

### Inferences
- Ruah should suggest retention signals with an explicit window (D1/D7/D30 for consumer apps; month-6 or 12 cohort for SaaS; NRR/GRR for revenue retention) — a retention target without a window is meaningless.
- "Retention curve flattens" is a qualitative signal Ruah could represent as "cohort retention at month N ≥ month N+3 minus small delta".

### Gaps
- Primary Adjust and AppsFlyer retention reports were not fetched; mobile D1/D7/D30 numbers come via UXCam aggregation. KeyBanc (KBCM) SaaS survey retention numbers not collected.
- Lenny's 6-month retention benchmarks are from 2020 (older than the preferred 2022+ window) but remain the most-cited practitioner benchmark.

---

## 6. Referral

### Takeaway
Referral signals: viral coefficient K = invites per user × invite conversion; K > 1 is self-sustaining viral growth, but real products rarely sustain it. NPS is widely used as a proxy but academic evidence shows it does not predict growth better than other satisfaction metrics.

### Metrics table

| Metric | Definition | Example | Benchmark range | Source + date |
|---|---|---|---|---|
| Viral coefficient (K-factor) | K = i × c, where i = avg invites sent per user, c = % of invites that convert to signups | 2 invites/user × 25% acceptance = K 0.5 | K > 1 = self-sustaining viral growth; K = 1 = flat/linear; K < 1 still amplifies paid acquisition | First Round Review glossary — [First Round](https://review.firstround.com/glossary/k-factor-virality/) [P]; [Andrew Chen, "Retention is king"](https://andrewchen.com/retention-is-king/) on retention mattering more than sharing [P] |
| Invite acceptance rate | Accepted invites ÷ invites sent | — | No credible cross-industry benchmark found | Gap |
| Net Promoter Score | % promoters (9–10) − % detractors (0–6) on "how likely to recommend" | — | Not a reliable growth predictor (see findings) | See below |

### Cited Findings
- Keiningham et al. (2007) replicated Reichheld's NPS study with a larger sample and found NPS performs no better than other satisfaction/loyalty measures at predicting growth — [Ipsos: The Net Promoter Debate](https://www.ipsos.com/en-us/net-promoter-debate); [MeasuringU](https://measuringu.com/nps-discredited/) [P]
- Studies by Morgan & Rego (2006), Keiningham et al. (2007), and Dawes (2022) found no link between NPS and sales growth; others found a link but not superiority over other mindset metrics; academics remain skeptical — [Nunan, "Two decades of NPS", 2024](https://journals.sagepub.com/doi/10.1177/14707853241242228) [P]

### Inferences
- For Ruah, referral-stage signals should prefer behavioral measures (invites sent per active user, invite → signup conversion, % of new users from referral) over NPS; NPS can be offered with a caveat.

### Gaps
- No credible published benchmark for invite acceptance rates or typical K values for B2B SaaS found in this pass.

---

## 7. Revenue (monetization)

### Takeaway
Free-to-paid conversion depends heavily on model: self-serve freemium ~3–5% good / 6–8% great; free trial ~8–12% good / 15–25% great (Lenny × OpenView, ~2023). In consumer subscription apps, hard paywalls convert ~5x freemium (10.7% vs 2.1% by Day 35) and longer trials convert better (42.5% vs 25.5%) (RevenueCat 2026).

### Metrics table

| Metric | Definition | Example | Benchmark range | Source + date |
|---|---|---|---|---|
| Free-to-paid conversion (freemium) | % of free signups who become paying within a window | — | Good 3–5%; great 6–8% (self-serve); sales-assisted freemium 10–15% | Lenny Rachitsky × Kyle Poyar (OpenView), survey of 1,000+ products, ~Aug 2023 — [Lenny's Newsletter](https://www.lennysnewsletter.com/p/what-is-a-good-free-to-paid-conversion); [Lenny on X](https://twitter.com/lennysan/status/1686421779479400448) [P, exact figures via summaries] |
| Free-trial conversion (opt-in, no card) | % of trial starters who pay at trial end | — | Good 8–12%; great 15–25% (self-serve); trials ≈ 2–3x freemium conversion | Same Lenny/OpenView source [P] |
| Trial-to-paid (consumer subscription apps) | % of trials converting to paid | — | By trial length: 17–32 days median 42.5% vs < 4 days 25.5%. By category (2025 report): Travel 48.7%, Media & Ent. 43.8%, Health & Fitness 39.9%; top decile ~68.3% | RevenueCat State of Subscription Apps 2026 — [RevenueCat blog](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026); 2025 report — [RevenueCat 2025](https://www.revenuecat.com/state-of-subscription-apps-2025) [P] |
| Install-to-paid by paywall type | % of installs paying by Day 35 | — | Hard paywall 10.7% vs freemium 2.1% (median) | RevenueCat 2026 [P] |
| Revenue per install (RPI) | Revenue ÷ installs at Day N | — | Day 60: hard paywall $3.09 vs freemium $0.38 | RevenueCat 2026 [P] |
| Trial cancellation timing | Share of trial cancellations by day | — | For 3-day trials, 55.4% of cancellations on Day 0; 84% on Day 0–1; >80% of trial starts occur on first app open | RevenueCat 2026 / 2025 [P] |
| Monthly revenue churn / NRR | See Retention section | — | See Retention section | — |
| ARPU | Revenue ÷ active (or paying) users per period | — | Product-specific; no universal benchmark collected | Gap |

### Inferences
- Ruah could default the revenue-stage signal by detected model: freemium → "free-to-paid ≥ 3–5% in 90 days"; trial → "trial-to-paid ≥ 8–12%"; consumer mobile subscription → RevenueCat category medians. Labels should state source and year.
- RevenueCat data shows conversion and retention can trade off (best-converting categories may churn faster), so a revenue signal should usually be paired with a retention signal.

### Gaps
- Opt-out (credit-card-required) trial conversion benchmarks (often quoted ~50–60%) not verified from a primary 2022+ source.
- ChartMogul ARPU/churn benchmarks not fetched.
- An aggregator search summary attributed "opt-in trials 17.8% vs freemium 3.7% (86 SaaS companies)" to First Page Sage; the primary source was not located, so it is excluded from the table.

---

## 8. Product-market fit signals

### Takeaway
Three widely used PMF signals: (1) Sean Ellis survey — ≥ 40% of users "very disappointed" if they could no longer use the product; (2) retention curves that flatten above zero (cohort benchmarks in section 5); (3) staged frameworks like First Round's Levels of PMF (Nascent → Developing → Strong → Extreme) across satisfaction, demand, and efficiency. Superhuman's "PMF engine" operationalized the Ellis survey (22% → 58%).

### Cited Findings
- Sean Ellis test: ask "How would you feel if you could no longer use this product?"; ≥ 40% answering "very disappointed" suggests PMF — [Zonka Feedback summary](https://www.zonkafeedback.com/blog/product-market-fit-survey); [Wikipedia: Product-market fit](https://en.wikipedia.org/wiki/Product-market_fit) [A]
- Superhuman (Rahul Vohra): initial PMF score 22%; segmented to the "very disappointed" users, doubled down on what they loved, and addressed what held back "somewhat disappointed" users; reached 58% about three quarters later — [First Round Review: How Superhuman built an engine to find PMF](https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/) [P]
- First Round "Levels of PMF" (Todd Jackson): four levels (Nascent, Developing, Strong, Extreme), three dimensions (Satisfaction, Demand, Efficiency), and four levers to get unstuck (persona, problem, promise, product); reaching Extreme PMF usually takes 2–6 years; Nascent = 3–5 customers with a real problem — [First Round Levels](https://www.firstround.com/levels); [First Round PMF Method](https://www.firstround.com/pmf); [Lenny's Podcast with Todd Jackson](https://www.lennysnewsletter.com/p/a-framework-for-finding-product-market) [P]
- Retention-based PMF: retention is the most important metric; flattening cohort curves at category-appropriate levels (see section 5) — [Lenny's Newsletter, 2020](https://www.lennysnewsletter.com/p/what-is-good-retention-issue-29) [P]

### Inferences
- For Ruah, PMF signals fit best at the journey level (not a single step): a "PMF survey ≥ 40% very disappointed" signal and a "cohort retention flattens at ≥ X% by month 6" signal.
- The 40% threshold is a heuristic from Ellis's experience, not a statistically derived cutoff; small survey samples (commonly < 100 responses) make it noisy.

### Gaps
- Ellis's primary source (pmfsurvey.com / his blog post origin) not fetched; minimum-sample guidance (e.g., ~40 responses) not verified.

---

## Summary cheat-sheet for Ruah signal suggestions

| Stage | Default signal to suggest | "Typical" range to show (label with source/year) |
|---|---|---|
| Acquisition | Landing page → signup conversion | Median 6.6% all industries; SaaS ~3.8% (Unbounce, ~2024) |
| Acquisition (e-com) | Checkout completion (1 − abandonment) | ~30% completion / 70.22% abandonment (Baymard, 2025) |
| Activation | % of signups reaching aha action within 7 days | SaaS median 30%, avg 36%; all products median 25% (Lenny, 2022) |
| Activation | Time-to-value | Avg ~1.5 days (Userpilot, 2024) |
| Activation | Onboarding checklist completion | Avg 19.2%, median 10.1% (Userpilot, 2024) |
| Engagement | DAU/MAU | B2B SaaS ~31%; e-com ~20% (Mixpanel, 2026) |
| Retention | Month-6 cohort retention | Consumer SaaS 40% good / 70% great; SMB SaaS 60/80; Enterprise 70/90 (Lenny, 2020) |
| Retention | D1/D7/D30 (mobile) | ~25% / ~12% / ~5–7% (UXCam aggregation, 2026) |
| Retention | NRR / GRR (B2B) | Median 101% / 91% (SaaS Capital, 2025) |
| Retention | Monthly logo churn | SMB 2.5–5% good; Enterprise 1–2% good; B2C 3–5% good (Lenny/ProfitWell, 2022) |
| Referral | K-factor; invites per user; invite → signup | K > 1 viral (definition, not benchmark) |
| Revenue | Free-to-paid (freemium) | 3–5% good, 6–8% great (Lenny/OpenView, 2023) |
| Revenue | Trial-to-paid (opt-in) | 8–12% good, 15–25% great (Lenny/OpenView, 2023); mobile subs 25.5–42.5% by trial length (RevenueCat, 2026) |
| PMF | Sean Ellis "very disappointed" | ≥ 40% |
| Growth (early stage) | Weekly revenue/active-user growth | 5–7%/week good, 10% exceptional (Paul Graham/YC, 2012) |
