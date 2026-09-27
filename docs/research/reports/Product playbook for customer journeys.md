# Make every journey step earn its why

The accelerator, venture and product-coaching canon agrees on one core rule: **learn from what specific customers did in the past, not from what they say they would do**, then judge the product by repeat use rather than sign-ups or praise. Y Combinator (Paul Graham, Michael Seibel, Eric Migicovsky, Gustaf Alströmer), Techstars, First Round, Sequoia, a16z, Rob Fitzpatrick's *The Mom Test*, Jobs-to-be-Done, Teresa Torres, Lenny Rachitsky and the Amplitude/Mixpanel analytics schools use different vocabularies but land in the same place. Recruit and onboard the first users by hand. Pick a narrow persona with an urgent, frequent problem. Interview for concrete stories. Define activation as the first delivery of core value at the product's natural frequency. Treat flattening retention and organic pull as the only product-market-fit (PMF) signals that everyone accepts. For Ruah this means that a journey step's `why` is a **falsifiable claim about a persona in a situation**. It should be backed by dated `evidence` graded by strength, paired with a `signal` that has a threshold and a time window, and followed by an open `question` wherever the evidence is thin. The in-tool agent should interrogate the builder and not write the why itself, because every source ranks the team's own opinion as the weakest evidence. Published benchmarks exist for every funnel stage, but they depend on the business model and the year, and several famous numbers (Facebook's "7 friends in 10 days", Slack's "2,000 messages", Dropbox's "one file in one folder") are correlational or poorly sourced. Ruah should show them as labelled illustrations, not targets. Sections 3–6 use fixed headings, tables and field names that match Ruah's `product.json` contract (`persona`, `goal`, `why`, `priority`, `steps[].screen`, `steps[].action`, `steps[].why`, `steps[].signal`, `steps[].question`, `evidence.quote/source/date`), so they can later be converted into machine-readable templates.

**How to read this report.** Material marked **[sourced]** is paraphrased from the linked source. **[aggregator]** means the figure came through a secondary summary, not the original publisher. **[contested]** means credible sources disagree. **[Ruah synthesis]** marks a structure, template, step or rule that this report derived from several sources for Ruah; no external source publishes it in this form. The journey steps in section 4, the question bank in section 5 and the evidence scale in section 2 are mostly Ruah synthesis grounded in the cited findings.

---

## 1. Seven principles converge on "watch behaviour, narrow the user, measure repeats"

### Founders learn fastest by doing the first hundred onboardings by hand

Paul Graham's central instruction is that founders must go and get users one at a time rather than wait for them. His examples are Stripe's "Collison installation", where the founders set up the integration on the prospect's laptop on the spot, and the Airbnb founders going door to door in New York to improve hosts' listings ([Graham, 2013](https://paulgraham.com/ds.html)). He argues that the earliest users should be onboarded personally, because watching them use the product gives feedback nothing else can. He also argues that the whole experience, not only the software, should delight them, and that **results a few months after launch depend more on how happy the first users were than on how many there were** ([Graham, 2013](https://paulgraham.com/ds.html)). Viaweb's "consulting" pattern, building merchants' stores for them, is the model for serving one user completely and generalising from that ([Graham, 2013](https://paulgraham.com/ds.html)). Superhuman shows the same approach at a larger scale. Founders and early staff onboarded hundreds of users one to one, **reached roughly twice the activation and twice the referrals of self-serve**, and spent about three years turning what they learned into a product-led flow ([First Round, 2025](https://review.firstround.com/superhuman-onboarding-playbook/)).

Two corollaries follow. First, the target user should be narrow. Graham prefers a small group who want the product badly (a "deep well") over many who want it a little, and he suggests testing an idea by asking who would put up with a crappy first version ([Graham, 2012](https://paulgraham.com/startupideas.html)). Kevin Hale's checklist says good problems are popular, growing, urgent, expensive, mandatory and frequent, ideally several of these at once ([YC Startup School, 2019](https://www.ycombinator.com/blog/startup-school-week-1-recap-kevin-hale-and-eric-migicovsky/)). Superhuman builds its persona from the users who would be "very disappointed" to lose the product, described in their own words ([Vohra, 2018](https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/)). Second, launching is continuous rather than a single event. Kat Mañalac describes a sequence from a quiet landing page, to friends, to strangers, to communities, to press ([YC Startup School, 2019](https://www.ycombinator.com/blog/startup-school-week-4-recap-kat-manalac-and-gustaf-alstromer/)). Seibel's version is that founders often grip their solution too tightly and their problem too loosely ([Seibel](https://www.michaelseibel.com/blog/the-real-product-market-fit)). For a solo developer using Ruah, "do things that don't scale" becomes something concrete: **record every manual onboarding session as evidence and derive the journey steps from those sessions**, instead of drawing the journey first and hoping users follow it [Ruah synthesis].

### Past behaviour beats opinion in every interview method

Eric Migicovsky's five Startup School questions are the YC standard. They ask what the hardest part of the job is, when the person last hit the problem, why it was hard, what they have tried, and what they dislike about those attempts. His list of mistakes is pitching, asking hypotheticals, and talking more than listening ([YC Startup School, 2019](https://www.ycombinator.com/blog/startup-school-week-1-recap-kevin-hale-and-eric-migicovsky/)). *The Mom Test* reduces this to three rules: talk about the customer's life, not your idea; ask about specific past events, not opinions about the future; and listen more than you speak ([Khanna Law notes](https://www.khanna.law/notes/the-mom-test), secondary summary of [Fitzpatrick](https://www.momtestbook.com/)). Fitzpatrick names three kinds of bad data. Compliments usually mean you slipped into pitching. Fluff means generic, future-tense or hypothetical claims. Feature requests should be probed for the motive behind them rather than added to the backlog. Real interest shows up only as **commitment paid in time, reputation or money** ([Khanna Law notes](https://www.khanna.law/notes/the-mom-test)). Techstars' toolkit also tells founders to understand the problem before the solution, to draw out stories, and to synthesise findings into functional, social and emotional jobs ([Techstars](https://toolkit.techstars.com/understand-your-customers)).

Teresa Torres turns this into a weekly routine. The team that builds the product interviews customers every week using story prompts ("tell me about the last time…"). After each interview it writes a one-page snapshot with a memorable quote, quick facts, opportunities, insights and an experience map ([Torres, 2024](https://www.producttalk.org/interview-snapshot/)). It then maintains an opportunity solution tree: an outcome at the root, then opportunities, then solutions, then assumption tests. The opportunities must come from interviews rather than the team's heads, and the team revisits the tree every three to four interviews so that the latest conversation does not dominate ([Torres, 2023](https://www.producttalk.org/opportunity-solution-trees/)). Jakob Nielsen supplies the empirical case. Across 113 interface comparisons, **stated preference and measured performance correlated at only 0.44** (0.53 in a later study), because people tell designers what they want to hear, misremember, and rationalise afterwards ([Nielsen, 2001](https://www.nngroup.com/articles/first-rule-of-usability-dont-listen-to-users/)).

### Jobs-to-be-Done explains circumstance, not demographics

Christensen and Moesta's milkshake study is the classic example of the say/do gap. A chain that changed flavour and thickness based on stated feedback saw no meaningful change in sales. Observation then revealed two unrelated jobs: commuters who wanted a long, filling distraction on the drive, and parents treating their children in the afternoon ([Re-Wired Group](https://therewiredgroup.com/case-studies/milkshakes/); [HBR, 2016](https://hbr.org/2016/09/know-your-customers-jobs-to-be-done)). Moesta and Spiek's Four Forces model says a customer switches only when **the push of the current pain plus the pull of the new solution outweighs anxiety about the new plus the habit of the old**, and that most teams work only on pull ([jobstobedone.org](https://jobstobedone.org/the-four-forces/)). Switch interviews reconstruct the timeline of a real purchase, from first thought through searching, deciding and early use ([June.so, 2025](https://www.june.so/blog/how-to-run-a-jtbd-interview-like-the-co-creator-of-the-framework)). Alan Klement's job story format, "When [situation], I want to [motivation], so I can [outcome]", is the most portable format for Ruah because it carries its own rationale ([Klement, 2013](https://www.intercom.com/blog/using-job-stories-design-features-ui-ux/)). The situation clause names the persona's context, the motivation clause becomes the `why`, and the outcome clause is what the `signal` should measure [Ruah synthesis].

### Activation means repeated core value at the natural frequency, not sign-up

Superhuman's onboarding uses a model it attributes to Reforge: signed up, then setup moment, then aha moment, then habit moment, then engaged. Its product-led flow follows three principles. It is opinionated (one best path), interruptive (full-screen steps replaced a checklist and **raised completion from 30% to 98%**) and interactive (users practise in a sandbox, with features taught right after the relevant action) ([First Round, 2025](https://review.firstround.com/superhuman-onboarding-playbook/)). Gustaf Alströmer adds the idea of "natural frequency". The core value metric should match how often the product is naturally used: yearly for Airbnb, daily for Instagram, every two weeks for payroll ([YC Startup School, 2019](https://www.ycombinator.com/blog/startup-school-week-4-recap-kat-manalac-and-gustaf-alstromer/)). Amplitude's North Star playbook sets one value-based metric with three to five input metrics the team can move directly ([Amplitude](https://amplitude.com/books/north-star/amplitudes-north-star-metric-and-inputs)). That maps onto Ruah as one journey-level `signal` fed by step-level `signal`s [Ruah synthesis]. a16z's Power User Curve, a histogram of days active per month, is more informative than DAU/MAU because it shows whether a core of daily users exists ([Jin and Chen, 2018](https://a16z.com/the-power-user-curve-the-best-way-to-understand-your-most-engaged-users/)).

Mixpanel adds a warning. The famous "magic numbers" are storytelling devices chosen from a correlational range, not causal tipping points. Andrew Chen has noted that Facebook's threshold could just as well have been stated differently ([Mixpanel, 2026](https://mixpanel.com/blog/magic-numbers-are-an-illusion/)). The defensible method is to list candidate early actions, compare later retention for users who did and did not do each one, choose the best trade-off between coverage and retention lift, and then run an experiment to test whether the relationship is causal [Ruah synthesis from the Mixpanel and Mode critiques]. For developer products the equivalent of the aha moment is time to first call. Postman calls it the most important API metric and measured **1.7x to 56x faster first calls** when publishers supplied ready-to-run collections ([Postman, 2021](https://blog.postman.com/the-most-important-api-metric-is-time-to-first-call/); [Postman, 2023](https://blog.postman.com/improve-your-time-to-first-api-call-by-20x/)).

### Retention and pull are the only PMF signals everyone agrees on

Andreessen described PMF as customers buying as fast as you can make the product. Signs of no fit are lukewarm value, no word of mouth and flat usage ([Andreessen, 2007](https://pmarchive.com/guide_to_startups_part4.html)). Seibel describes a team struggling to keep up with growing numbers of happy, paying users, and warns that declaring PMF too early leads to premature hiring ([Seibel](https://www.michaelseibel.com/blog/the-real-product-market-fit)). The main disagreement is about measurement **[contested]**. Migicovsky and Superhuman endorse Sean Ellis's survey, where 40% or more saying "very disappointed" indicates PMF; Superhuman went from 22% to 58% in three quarters ([Vohra, 2018](https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/)). Alströmer, also at YC, says surveys and NPS correlate poorly with real PMF and that flattening cohort retention curves are the unbiased test ([YC Startup School, 2019](https://www.ycombinator.com/blog/startup-school-week-4-recap-kat-manalac-and-gustaf-alstromer/)). Sequoia's Arc framework adds a useful tag for each persona. *Hair on fire* problems need a clearly differentiated experience. *Hard fact* problems need a reason to overcome inertia. *Future vision* problems need education and interim milestones ([Sequoia, 2024](https://www.sequoiacap.com/article/pmf-framework/)). First Round's Levels of PMF measure satisfaction, demand and efficiency. They treat onboarding that lasts eight weeks or more, and heavy customisation requests, as signs of only nascent fit ([First Round, 2024](https://www.firstround.com/levels)). a16z cautions that early retention for AI products is distorted by "tourists" who try things cheaply and leave ([a16z, 2025](https://a16z.com/ai-retention-benchmarks/)). The reasonable reading is that the survey is a cheap, noisy early instrument and retention is the verdict, so Ruah should suggest both at the journey level [Ruah synthesis].

---

## 2. A good why is a falsifiable claim with dated evidence

Every framework examined here asks some version of the same five things. Who is the customer? What problem are they in? How do we know? What does this design do about it? How will we tell whether it worked? Amazon's Working Backwards starts from almost exactly these questions: who the customer is, what their problem is, the most important benefit, how you know, and what the experience looks like ([Working Backwards](https://workingbackwards.com/concepts/working-backwards-pr-faq-process/)). Michael Nygard's decision records add that context should be stated neutrally, that consequences should be listed whether good or bad, and that a record is worthless once it goes stale ([Nygard, 2011](https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions)). Torres adds that a real opportunity is one that several different solutions could address. **A why that names a feature rather than a problem is a solution in disguise** ([Torres, 2023](https://www.producttalk.org/opportunity-solution-trees/)).

### why_template [Ruah synthesis]

| slot | maps to field | prompt | sourced basis |
|---|---|---|---|
| `situation` | `persona` + `steps[].why` | For [persona], when [situation]… | Job stories ([Klement](https://www.intercom.com/blog/using-job-stories-design-features-ui-ux/)) |
| `problem` | `steps[].why` | …they struggle with [problem / job], not "they want [feature]" | Opportunity vs solution ([Torres](https://www.producttalk.org/opportunity-solution-trees/)) |
| `how_we_know` | `steps[].evidence[]` | We know because [quote, source, date], strength level N | PR-FAQ question 4 ([Working Backwards](https://workingbackwards.com/concepts/working-backwards-pr-faq-process/)) |
| `design_move` | `steps[].action`, `steps[].screen` | This step [does X] so they can [outcome] | Job story outcome clause |
| `signal` | `steps[].signal` | We'll know it works when [metric] reaches [threshold] within [window] | North Star inputs ([Amplitude](https://amplitude.com/books/north-star/amplitudes-north-star-metric-and-inputs)) |
| `open_question` | `steps[].question` | Biggest open assumption: [question] (desirability / usability / feasibility / viability / ethics) | Five assumption types ([Torres](https://www.producttalk.org/five-types-of-assumptions/)) |

Grading evidence strength combines three sourced orderings. Itamar Gilad's Confidence Meter ranks self-conviction, trends and colleagues' opinions near zero, anecdotes and market data in the middle, and customer evidence, test results and launch data at the top ([Gilad](https://itamargilad.com/the-tool-that-will-help-you-choose-better-product-ideas/)). Nielsen ranks predictions of future behaviour as the least trustworthy user data ([Nielsen, 2001](https://www.nngroup.com/articles/first-rule-of-usability-dont-listen-to-users/)). Fitzpatrick treats commitment as the currency of real interest ([Khanna Law notes](https://www.khanna.law/notes/the-mom-test)). Gilad's exact numeric weights sit behind an email gate, so only the ordering is sourced. **The 0–7 scale below is a Ruah synthesis, not an industry standard.**

### evidence_strength [Ruah synthesis]

| level | `kind` | example | label | agent default |
|---|---|---|---|---|
| 0 | `opinion` | "Users obviously want dark mode" | none | open `question`; do not count as evidence |
| 1 | `thematic` | "Linear has it", a trend, one stakeholder's view | very weak | open `question` |
| 2 | `stated_preference` | "I would use that", survey intent, feature request | weak | open `question`; ask for a past instance |
| 3 | `past_behavior` | "Last Tuesday I exported to CSV and pasted it into Sheets" (one interview) | moderate | accept; mark why tentative |
| 4 | `past_behavior_pattern` | 4 of 6 interviewees describe the same workaround; support-ticket cluster | moderate–strong | accept |
| 5 | `commitment` | pilot signed, intro given, pre-order, paid | strong | accept |
| 6 | `observed_behavior` | usability test, prototype test, funnel data, A/B result | strong | accept |
| 7 | `launch_data` | post-launch retention change on the real metric | strongest | accept |

Ruah's current `Evidence` type holds only `quote`, `source` and `date`. Adding optional `kind` and `strength` fields, or deriving them from the quote text and source, would let the tool show strength next to each `why` and open a `question` automatically when the best evidence is level 2 or below [Ruah synthesis]. Torres's advice to map opportunities only after three to four interviews supports marking a why backed by a single story as tentative ([Torres, 2023](https://www.producttalk.org/opportunity-solution-trees/)).

### why_examples [Ruah synthesis, illustrative]

| verdict | `steps[].why` | what is wrong or right |
|---|---|---|
| weak | "Users want an onboarding wizard." | No persona, no evidence, no signal; names a solution, not a problem |
| weak | "Competitor X has it." | Level 1 thematic support only |
| weak | "Customer Acme asked for it." | A single feature request, the bad-data category in the Mom Test |
| weak | "Improves engagement." | No situation, and the signal is a vanity metric with no threshold |
| good | "Solo devs setting up a first project stall when asked to pick a model before seeing any value; 3 of 5 interviewees (Sept 2026) quit at that screen. Deferring the choice gets them to a first agent run. Signal: share of new projects reaching first run within 10 minutes rises from X to Y. Open question (desirability): do power users feel slowed by the default?" | Persona + situation, level 4 dated evidence, design move, windowed signal, typed open question |

---

## 3. Stage signals: benchmarks exist, but only with model, year and window

Ruah can suggest a `signal` for any step once it knows the step's stage. The benchmarks below are **defaults to show next to a suggestion, always labelled with source and year**, not targets. Four rules make a signal usable, and each is Ruah synthesis grounded in the sources. The signal needs a metric, a direction, a threshold and a window, because a retention figure without a window is meaningless. It should measure the outcome clause of the why rather than a nearby vanity event; Alströmer calls registered users "a really bad" metric ([YC, 2019](https://www.ycombinator.com/blog/startup-school-week-4-recap-kat-manalac-and-gustaf-alstromer/)). It should run at the product's natural frequency rather than defaulting to daily. And a revenue signal should be paired with a retention signal, because RevenueCat's data shows the best-converting categories can churn faster ([RevenueCat, 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026)).

Column meanings: `signal_id` is stable; `benchmark` is the published range; `population` is who was measured; `status` is `sourced`, `aggregator` or `contested`.

### stage: acquisition

| signal_id | signal | definition | benchmark | population | source | year | status |
|---|---|---|---|---|---|---|---|
| `acq.landing_conversion` | Landing page → conversion | conversions ÷ unique visitors | median 6.6% all industries; SaaS ~3.8%; events ~12.3% | 41,000 landing pages, 464M visits | [Unbounce](https://unbounce.com/landing-pages/whats-a-good-conversion-rate/) | ~2024 | sourced |
| `acq.conversion_by_channel` | Conversion by traffic source | landing conversion split by channel | email ~19.3%, paid social ~12%, paid search ~10.9%, display ~4.1% | same | [Unbounce](https://unbounce.com/landing-pages/whats-a-good-conversion-rate/) | ~2024 | aggregator (via snippet) |
| `acq.visit_to_signup` | Website visitor → signup | signups ÷ visitors | freemium ~6% vs trial ~3–4% (Lenny/OpenView); **conflicts with** freemium ~9% vs trial ~5% (OpenView snippet) | 1,000+ SaaS products | [Lenny](https://www.lennysnewsletter.com/p/what-is-a-good-free-to-paid-conversion); [OpenView](https://openviewpartners.com/2022-product-benchmarks/) | 2022–2023 | contested |
| `acq.growth_weekly` | Weekly growth of revenue or active users | week-over-week % | 5–7%/wk good, 10% exceptional, 1% "not figured out" | YC batch companies, ~3-month window | [Graham](https://paulgraham.com/growth.html) | 2012 | sourced; dated, venture-scale only; criticised as gameable ([TechCrunch, 2016](https://techcrunch.com/2016/12/18/growth-as-a-false-signal-in-y-combinator-startups/)) |
| `acq.docs_to_signup` | Docs/quickstart view → signup (dev tools) | signups ÷ quickstart views | no published benchmark | — | — | — | gap |

### stage: activation

| signal_id | signal | definition | benchmark | population | source | year | status |
|---|---|---|---|---|---|---|---|
| `act.activation_rate` | Signup → activation event within window | % of new signups completing the aha action in N days | all products avg 34%, median 25%; SaaS avg 36%, median 30%; 60th pct "good", 80th "great" | 500+ survey responses | [Lenny & Timen](https://www.lennysnewsletter.com/p/what-is-a-good-activation-rate) | 2022 | sourced |
| `act.activation_rate_vendor` | Same, vendor sample | as above | avg ~37.5% | 547 Userpilot SaaS customers | [Userpilot](https://userpilot.com/blog/product-metrics-benchmark-report/) | 2024 | aggregator (vendor, snippet) |
| `act.time_to_value` | Time to value | median time from signup to first value event | avg ~1 day 12 h | 547 SaaS companies | [Userpilot](https://userpilot.com/blog/time-to-value-benchmark-report-2024/) | 2024 | sourced (vendor); "top quartile < 5 min" unverified |
| `act.checklist_completion` | Onboarding checklist completion | % of checklist starters finishing all items | avg 19.2%, median 10.1%; fintech 24.5%, martech 12.5% | Userpilot customers | [Userpilot](https://userpilot.medium.com/customer-onboarding-checklist-completion-rate-2024-benchmark-report-8ebabebefb1f) | 2024 | sourced (vendor) |
| `act.onboarding_completion_fullscreen` | Required full-screen onboarding completion | % completing onboarding | 30% (checklist) → 98% (full-screen steps) | Superhuman only | [First Round](https://review.firstround.com/superhuman-onboarding-playbook/) | 2025 | sourced; single company |
| `act.time_to_first_call` | Time to first call / hello world (dev tools) | median minutes from discovery or signup to first 2xx | one publisher 17 → 10 min; 1.7x–56x faster with runnable examples | small, unnamed set of API publishers | [Postman](https://blog.postman.com/improve-your-time-to-first-api-call-by-20x/) | 2023 | sourced; small sample |
| `act.first_session_core_action` | Day-0 core action (mobile) | % of installers completing the first core action on Day 0 | claim: 2–3x retention for apps that do this well | unclear | [UXCam](https://uxcam.com/blog/mobile-app-retention-benchmarks/) | 2026 | aggregator |
| `act.magic_number` | N actions in T days | threshold correlated with later retention | company-specific; see contested table (section 7) | — | [Mixpanel](https://mixpanel.com/blog/magic-numbers-are-an-illusion/) | 2026 | contested |

### stage: core_action

| signal_id | signal | definition | benchmark | population | source | year | status |
|---|---|---|---|---|---|---|---|
| `core.dau_mau` | Stickiness | DAU ÷ MAU | B2B SaaS ~31% (NA/EMEA), APAC ~33%; e-commerce ~20%; NA AI products ~21% | 12,000+ Mixpanel customers | [Mixpanel](https://mixpanel.com/benchmarks/) | 2026 | sourced (figures via snippet) |
| `core.dau_mau_rule_of_thumb` | Stickiness "rule of thumb" | as above | social 20%+ "good", B2B 10–15% | unknown | search aggregation | — | contested; conflicts with Mixpanel's 31% for B2B |
| `core.power_user_curve` | L30 / L7 histogram | users bucketed by active days per month or week | healthy = "smile" with a daily cluster | — | [a16z](https://a16z.com/the-power-user-curve-the-best-way-to-understand-your-most-engaged-users/) | 2018 | sourced (method, no benchmark) |
| `core.actions_per_active` | Core actions per active user | value-defining action count ÷ actives per period | product-specific | — | [Amplitude](https://amplitude.com/books/north-star/amplitudes-north-star-metric-and-inputs) | — | sourced (method) |
| `core.north_star` | North Star metric | one value-capturing metric + 3–5 inputs | product-specific | — | [Amplitude](https://info.amplitude.com/rs/138-CDN-550/images/Amplitude-The-North-Star-Playbook.pdf) | — | sourced (method) |

### stage: retention

| signal_id | signal | definition | benchmark (good / great) | population | source | year | status |
|---|---|---|---|---|---|---|---|
| `ret.m6_user` | Month-6 cohort user retention | % of signup cohort active in month 6 | consumer social 25/45%; consumer transactional 30/50%; consumer SaaS 40/70%; SMB/mid-market SaaS 60/80%; enterprise SaaS 70/90% | 20 growth practitioners | [Lenny](https://www.lennysnewsletter.com/p/what-is-good-retention-issue-29) | 2020 | sourced; pre-2022 |
| `ret.nrr_12m` | 12-month net revenue retention | (start + expansion − contraction − churn) ÷ start | consumer SaaS 55/80%; bottom-up SaaS 100/120%; SMB/mid 90/110%; enterprise 110/130% | same | [Lenny](https://www.lennysnewsletter.com/p/what-is-good-retention-issue-29) | 2020 | sourced; pre-2022 |
| `ret.nrr_grr_private_saas` | NRR / GRR, private B2B SaaS | GRR excludes expansion | median NRR 101%, GRR 91%; bootstrapped 104/92%; GRR ≥ 90% "table stakes" | companies > $1M ARR | [SaaS Capital](https://www.saas-capital.com/blog-posts/what-is-a-good-retention-rate-for-a-private-saas-company/) | 2025 | sourced |
| `ret.monthly_logo_churn` | Monthly customer churn | customers lost ÷ customers at start of month | SMB/mid 2.5–5% good, < 1.5% great; enterprise 1–2% / < 0.5%; B2C SaaS 3–5% / < 2% | ProfitWell data, 13,000 SaaS companies | [Lenny](https://www.lennysnewsletter.com/p/monthly-churn-benchmarks) | 2022 | sourced |
| `ret.mobile_d1_d7_d30` | Mobile D1 / D7 / D30 | % of installers returning on day N | ~25% / 11–13% / 5–7% overall; D30 social 15–20%, fintech 10–15%, e-com 3–6% | aggregated attribution data | [UXCam](https://uxcam.com/blog/mobile-app-retention-benchmarks/) | 2026 | aggregator |
| `ret.sub_12m` | 12-month subscriber retention | % of payers still subscribed after 12 months | hard paywall ~27%, freemium ~28%; annual plans lose ~72% in year 1; 35% of annual cancellations in month 1 | 115,000+ apps, $16B revenue | [RevenueCat](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026) | 2026 | sourced |
| `ret.curve_flattens` | Cohort curve flattens | retention at month N+3 ≈ month N | qualitative; example ~30% at M2 → ~21% at M20 | one YC talk example | [YC](https://www.ycombinator.com/blog/startup-school-week-4-recap-kat-manalac-and-gustaf-alstromer/); example via [secondary summary](https://videohighlight.com/v/6lY9CYIY4pQ) | 2019 | sourced (rule); example aggregator |

### stage: referral

| signal_id | signal | definition | benchmark | population | source | year | status |
|---|---|---|---|---|---|---|---|
| `ref.k_factor` | Viral coefficient | invites per user × invite conversion | K > 1 self-sustaining (a definition, not a benchmark) | — | [First Round](https://review.firstround.com/glossary/k-factor-virality/) | — | sourced |
| `ref.invites_per_account` | Invites sent per active account | invites ÷ active accounts per period | no credible benchmark | — | — | — | gap |
| `ref.invite_acceptance` | Invite acceptance | accepted ÷ sent | no credible benchmark | — | — | — | gap |
| `ref.referral_inbound_share` | Share of new customers from referral | referral-sourced ÷ all new | > 10% at Level 3 PMF; 13%+ at Level 4 | B2B/enterprise | [First Round Levels](https://www.firstround.com/levels) | 2024 | sourced; B2B only |
| `ref.nps` | Net Promoter Score | % promoters − % detractors | not a reliable growth predictor | replications 2006–2022 | [Ipsos](https://www.ipsos.com/en-us/net-promoter-debate); [Nunan, 2024](https://journals.sagepub.com/doi/10.1177/14707853241242228) | 2024 | contested; offer only with a caveat |

### stage: revenue

| signal_id | signal | definition | benchmark (good / great) | population | source | year | status |
|---|---|---|---|---|---|---|---|
| `rev.freemium_to_paid` | Free → paid (self-serve freemium) | % of free signups paying within window | 3–5% / 6–8%; sales-assisted 10–15% | 1,000+ products | [Lenny & Poyar](https://www.lennysnewsletter.com/p/what-is-a-good-free-to-paid-conversion) | ~2023 | sourced (exact figures via summaries) |
| `rev.trial_to_paid_optin` | Trial → paid (no card) | % of trial starters paying at trial end | 8–12% / 15–25% | same | [Lenny & Poyar](https://www.lennysnewsletter.com/p/what-is-a-good-free-to-paid-conversion) | ~2023 | sourced |
| `rev.trial_to_paid_card` | Trial → paid (card required) | as above | ~40–60% | OpenView/ProfitWell per snippet | [OpenView](https://openviewpartners.com/blog/your-guide-to-product-led-growth-benchmarks/) | ~2022 | aggregator; unverified |
| `rev.sales_touch_lift` | Conversion when sales contacts > 50% of signups | relative lift | ~2x (trial), ~4x (freemium) | OpenView sample | [OpenView](https://openviewpartners.com/2022-product-benchmarks/) | ~2022 | aggregator (snippet) |
| `rev.install_to_paid_d35` | Install → paid by Day 35 (mobile) | payers ÷ installs | hard paywall 10.7% vs freemium 2.1% (median) | 115,000+ apps | [RevenueCat](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026) | 2026 | sourced |
| `rev.mobile_trial_to_paid` | Mobile trial → paid | % of trials converting | 17–32-day trials 42.5% vs < 4-day 25.5% (RevenueCat); overall 25.6%, Health & Fitness 35.0% (Adapty) | 115,000 apps / 16,000 apps | [RevenueCat](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026); [Adapty](https://adapty.io/state-of-in-app-subscriptions/) | 2026 | sourced |
| `rev.rpi_d60` | Revenue per install, Day 60 | revenue ÷ installs | hard paywall $3.09 vs freemium $0.38 | 115,000+ apps | [RevenueCat](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026) | 2026 | sourced |
| `rev.checkout_completion` | Checkout completion (e-commerce) | 1 − cart abandonment | abandonment avg 70.22% (≈ 30% completion) | average of 50 studies | [Baymard](https://baymard.com/lists/cart-abandonment-rate) | 2025 | sourced |

### stage: pmf (journey level only)

| signal_id | signal | definition | benchmark | population | source | year | status |
|---|---|---|---|---|---|---|---|
| `pmf.ellis_survey` | "Very disappointed" share | % answering "very disappointed" if the product disappeared | ≥ 40% | Ellis's portfolio experience; Superhuman 22% → 58% | [Vohra](https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/) | 2018 | contested (Alströmer); noisy under ~100 responses |
| `pmf.retention_flattening` | Retention flattens above category norm | see `ret.m6_user` | category-dependent | — | [YC](https://www.ycombinator.com/blog/startup-school-week-4-recap-kat-manalac-and-gustaf-alstromer/) | 2019 | sourced |
| `pmf.first_round_level` | PMF level | Nascent / Developing / Strong / Extreme on satisfaction, demand, efficiency | L1: 3–5 customers, 8+ week onboarding; L2: 10–20% regretted churn; L3: 110%+ NRR | B2B/enterprise | [First Round](https://www.firstround.com/levels) | 2024 | sourced; B2B only |

---

## 4. Seven journey templates show where standard layouts come from

Every template below uses the same headings and field names, so each block can become a JSON template. `personas` lists `persona_id`, `persona` and `goal`. `journeys` lists `journey_id`, `persona`, `goal`, `priority` (`core` / `secondary` / `edge`), journey-level `why` and `signal`. Each `steps` table lists `screen`, `action`, `why`, `signal` and `basis`, where `basis` names the source behind the why or says **synthesis**. `standard_layout` explains conventional placement, and `drop_off_points` lists where users leave, with data where published. **The personas, journeys and steps are Ruah synthesis**, because no source publishes standard journeys for a category. The facts inside the whys are sourced, and a template's why is a starting hypothesis the builder must replace with their own evidence.

### template: fintech_bank

Monitoring dominates banking use. **94% of US mobile-banking users checked balances or recent transactions, 58% moved money between their own accounts and 56% received alerts** (Fed survey fielded November 2015) ([Federal Reserve, 2016](https://www.federalreserve.gov/econresdata/mobile-devices/2016-executive-summary.htm)). Onboarding is where most users are lost. In Signicat's European surveys, the share of consumers who abandoned at least one financial onboarding in the prior year rose from 38% (2019) to **68% (2022)** ([Signicat, 2022](https://www.signicat.com/press-releases/the-battle-to-onboard-2022)). This is self-reported abandonment, not a funnel rate.

#### personas

| persona_id | persona | goal |
|---|---|---|
| `everyday_spender` | Everyday spender / salary earner | "Know what I can spend and never get caught out." |
| `new_switcher` | New-to-bank mobile-only switcher (Gen Z–44) | "Have a working account and card today." |
| `security_anxious` | Security-focused user | "Stop bad things fast and get reassurance." |

#### journeys

| journey_id | persona | goal | priority | why | signal |
|---|---|---|---|---|---|
| `onboarding_kyc` | `new_switcher` | Open an account on my phone | core | The biggest loss point in financial apps; abandonment is driven by missing documents and data overreach | KYC pass rate; time to account open; first funding within 24 h |
| `check_balance` | `everyday_spender` | See if I'm fine this month | core | The #1 task (94%) | Time from launch to balance visible; sessions per week |
| `send_transfer` | `everyday_spender` | Pay someone | core | Next most frequent task after monitoring | Transfer success rate; cancels at confirm |
| `freeze_card` | `security_anxious` | Stop a lost card now | secondary | Stressful, time-critical, support-heavy moment | Time to freeze; support contacts after a freeze |
| `alert_to_action` | `everyday_spender` | Avoid going overdrawn | secondary | Alerts demonstrably trigger deposits and transfers | Alert tap rate; action within 1 h of alert |

#### steps: onboarding_kyc

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Welcome | Taps "Open account" | Commit before any document request; list the required documents up front | Welcome → start rate | 38% lacked the right ID ([Signicat](https://www.signicat.com/the-battle-to-onboard-2022), snippet) |
| 2 | Phone/email + OTP | Verifies contact | Low-effort first commitment | OTP success | synthesis |
| 3 | Personal details | Enters the minimum fields | 21% abandoned over excessive data requests | Field completion; step drop-off | [Signicat](https://www.signicat.com/the-battle-to-onboard-2022) (snippet) |
| 4 | ID capture + selfie | Scans document, liveness check | Regulatory gate; the costliest step, so place it after commitment | KYC pass rate; retries | [Signicat](https://www.signicat.com/press-releases/the-battle-to-onboard-2022) |
| 5 | Review + consent | Confirms | Legal requirement; builds trust | Consent completion | synthesis |
| 6 | Account ready | Receives a virtual card; prompted to add money / Apple or Google Pay | Immediate value closes the loop on day 0 | First funding within 24 h | synthesis |

#### steps: check_balance

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Launch | Biometric log-in | Security that feels effortless; MFA users are 16 points more satisfied | Log-in success; time to home | [J.D. Power, 2025](https://www.jdpower.com/business/press-releases/2025-us-banking-and-credit-card-mobile-app-satisfaction-studies) |
| 2 | Home | Reads available balance and latest transactions | The dominant task needs zero taps after log-in | Time from launch to balance | [Fed, 2016](https://www.federalreserve.gov/econresdata/mobile-devices/2016-executive-summary.htm) |
| 3 | Transaction detail | Taps a transaction for merchant/category | Resolves "what was this?" without a support call | Detail views; disputes raised | synthesis |

#### steps: send_transfer

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Home | Taps "Pay/Send" | Second-most-frequent task sits next to the balance | Tap-through from home | [Fed, 2016](https://www.federalreserve.gov/econresdata/mobile-devices/2016-executive-summary.htm) |
| 2 | Payee | Picks from recents or searches | Recents cut repeat effort | Repeat-payee share | synthesis |
| 3 | Amount + reference | Enters amount | — | Step drop-off | synthesis |
| 4 | Confirm | Checks payee name, fee, arrival time; biometric/SCA | Prevents mistakes and fraud | Cancels at confirm; payee-mismatch warnings | synthesis |
| 5 | Receipt | Shares or finishes | Reassurance and proof | Transfer success rate | synthesis |

#### steps: freeze_card

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Home → Card | Taps the card | Card controls one tap away for panic moments | Time to freeze | [Monzo Help](https://monzo.com/ie/help/using-monzo/help-home-screen) |
| 2 | Card | Toggles "Freeze" (reversible) | Reversibility lowers panic; blocks payments instantly | Unfreeze rate (false alarms resolved by the user) | [Monzo Help](https://monzo.com/help/app-help/finding-features-new-homescreen) |
| 3 | Card | Optionally reports lost/stolen and reissues | Escalation path only if needed | Support contacts after freeze | synthesis |

#### standard_layout

| element | placement | why | basis |
|---|---|---|---|
| Balance + recent transactions | Top of home | Monitoring is the dominant use | [Fed, 2016](https://www.federalreserve.gov/econresdata/mobile-devices/2016-executive-summary.htm) |
| 2–3 primary actions (Pay, Add money, Card) | Directly under balance | Next most frequent tasks | [Fed, 2016](https://www.federalreserve.gov/econresdata/mobile-devices/2016-executive-summary.htm); [Monzo](https://monzo.com/blog/how-we-built-the-new-home-screen) (snippet) |
| Card freeze | On the account card | Time-critical moments | [Monzo Help](https://monzo.com/ie/help/using-monzo/help-home-screen) |
| Biometric log-in | App launch | Security as satisfaction driver | [J.D. Power, 2025](https://www.jdpower.com/business/press-releases/2025-us-banking-and-credit-card-mobile-app-satisfaction-studies) |

#### drop_off_points

| step | drop_off | data | source |
|---|---|---|---|
| `onboarding_kyc.4` | ID document / liveness | 68% of European consumers abandoned a financial onboarding in the prior year (2022) | [Signicat](https://www.signicat.com/press-releases/the-battle-to-onboard-2022) |
| `onboarding_kyc.3` | Too much personal data | 21% cite it | [Signicat](https://www.signicat.com/the-battle-to-onboard-2022) (snippet) |
| `onboarding_kyc.1` | Missing credentials | 38% cite it | [Signicat](https://www.signicat.com/the-battle-to-onboard-2022) (snippet) |

### template: b2b_saas

The product-led pattern runs from signup, to workspace setup, to first value, to inviting teammates, to a team habit, to upgrade or a sales-assisted sale. Collaboration drives expansion. Chen puts Slack's atomic network at about three users ([Rekhi on Chen, 2021](https://www.sachinrekhi.com/p/andrew-chen-the-cold-start-problem)), and OpenView reports conversion roughly doubling for trials and quadrupling for freemium when sales contacts more than half of signups ([OpenView, ~2022](https://openviewpartners.com/2022-product-benchmarks/), snippet). **When to prompt invites is contested.** Appcues praises Slack's early prompt, while other onboarding frameworks put invites after activation ([Appcues, 2026](https://www.appcues.com/blog/8-user-onboarding-strategies)). The Ruah synthesis rule is to invite as soon as there is something worth sharing; for products with no single-player value, that moment is signup.

#### personas

| persona_id | persona | goal |
|---|---|---|
| `admin_buyer` | Admin / buyer (usually the first signup) | "Prove this solves a team problem and justify the spend." |
| `end_user` | First individual user | "Get my own job done faster." |
| `invited_teammate` | Invited teammate | "Understand why I'm here and contribute fast." |
| `approver` | IT / security / economic approver | "Approve spend and security without risk." |

#### journeys

| journey_id | persona | goal | priority | why | signal |
|---|---|---|---|---|---|
| `signup_setup` | `admin_buyer` | Get a workspace running | core | Most signups never reach value | Signup → setup completion |
| `first_value` | `end_user` | Do one real task | core | Activation is the leading predictor of retention | `act.activation_rate` within 7 days |
| `invite_team` | `end_user` | Bring my team in | core | Team-level activation predicts retention and purchase intent (Slack, Figma) | Accounts reaching ≥ 3 active users |
| `teammate_lands` | `invited_teammate` | Help on the thing I was sent | core | Invitees arrive mid-flow and need context, not a tour | Teammate activation |
| `upgrade` | `admin_buyer` | Unlock the team feature we hit | secondary | Upgrade tied to value already received | Paywall → trial/paid |
| `sales_assist` | `admin_buyer` | Get help buying | secondary | Sales touch lifts conversion | PQL → opportunity |
| `admin_hardening` | `approver` | Roll out safely | edge | SSO/SCIM gates company-wide rollout | Security review passed; seat expansion |

#### steps: first_value

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Use-case question | Picks a use case | Personalises templates and sample data | Answer rate | synthesis |
| 2 | Pre-filled template / sample data | Edits or runs one core action | An empty canvas stalls users | Activation event | [Appcues, 2026](https://www.appcues.com/blog/8-user-onboarding-strategies) |
| 3 | Checklist (3–5 items) | Completes the items | Visible progress; keep it short | `act.checklist_completion` | [Appcues](https://www.appcues.com/blog/8-user-onboarding-strategies); [Userpilot](https://userpilot.medium.com/customer-onboarding-checklist-completion-rate-2024-benchmark-report-8ebabebefb1f) |

#### steps: invite_team

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | The first artifact (doc, issue, board) | Sees "Share this" prompt in context | A concrete reason to invite; the invitee lands on something real | Invite prompt → send | synthesis from [Rekhi/Chen](https://www.sachinrekhi.com/p/andrew-chen-the-cold-start-problem) |
| 2 | Invite modal | Invites by email, link or domain auto-join | Lower friction per invite | `ref.invites_per_account` | synthesis |
| 3 | Invitee's landing: the shared object | Invitee comments or edits | Value from the first click | Teammate activation | synthesis |
| 4 | Workspace | Third active user joins | Atomic network (~3 for Slack) | Time to 3 active users | [Rekhi/Chen](https://www.sachinrekhi.com/p/andrew-chen-the-cold-start-problem) |

#### steps: upgrade and sales_assist

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Usage limit / gated collaborative feature | Hits the limit | PQL signal: limits hit, invites, premium use | PQL rate | [Dock](https://www.dock.us/library/product-qualified-leads) (snippet) |
| 2 | Upgrade / reverse trial | Starts trial or pays | Reverse trial pairs trial urgency with freemium reach | `rev.freemium_to_paid` / `rev.trial_to_paid_optin` | [Poyar, 2022](https://x.com/poyark/status/1537064035052568578?lang=en) |
| 3 | Human outreach | Talks to sales | Sales touch lifts conversion ~2–4x | PQL → win rate | [OpenView](https://openviewpartners.com/2022-product-benchmarks/) (snippet) |

#### standard_layout

| element | placement | why | basis |
|---|---|---|---|
| Templates / sample data | First screen after setup | Avoid the empty state | [Appcues](https://www.appcues.com/blog/8-user-onboarding-strategies) |
| Checklist | Side panel, 3–5 items | Progress without overload | [Appcues](https://www.appcues.com/blog/8-user-onboarding-strategies) |
| Share / invite | On the object, not in settings | Invitation tied to content | synthesis |
| Billing, SSO, roles | Admin settings | Only the admin/approver needs it | synthesis |

#### drop_off_points

| step | drop_off | data | source |
|---|---|---|---|
| `first_value.2` | Never reaches first value | ~62% of signups never activate (vendor avg 37.5% activation) | [Userpilot, 2024](https://userpilot.com/blog/product-metrics-benchmark-report/) (snippet) |
| `signup_setup` | Too many setup questions | no per-step public data | gap |
| `invite_team.1` | Invite skipped | no public data | gap |
| `upgrade.2` | Trial end / paywall | freemium converts 2–5% | [OpenView](https://openviewpartners.com/blog/your-guide-to-product-led-growth-benchmarks/) (snippet) |

### template: marketplace

**14 of 17 successful consumer marketplaces studied grew supply first**, about 60% used direct sales for early supply, and the median one succeeded with just two supply levers ([Rachitsky, 2019](https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-9ee); [Rachitsky, 2019](https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-911)). The sample of 17 large survivors skews the result. a16z's 13 marketplace metrics centre on liquidity (match rate, market depth, time to match, "zeros" or searches with no match), concentration and cohort retention ([a16z, 2020](https://a16z.com/13-metrics-for-marketplace-companies/)).

#### personas

| persona_id | persona | goal |
|---|---|---|
| `supplier` | Supplier / seller / provider (usually the hard side) | "Earn or reach customers with little setup and risk." |
| `buyer` | Buyer | "Find a trustworthy match fast and transact safely." |
| `ops` | Ops / trust & safety | "Keep liquidity and quality high, fraud low." |

#### journeys

| journey_id | persona | goal | priority | why | signal |
|---|---|---|---|---|---|
| `supply_onboarding` | `supplier` | Get my first listing live | core | Supply is usually the constraint | Time to first listing live |
| `supply_first_sale` | `supplier` | Earn my first money | core | First earnings drive supplier retention | Time to first transaction |
| `demand_search_book` | `buyer` | Find and book | core | Liquidity is the core health signal | Match rate; searches with ≥ 1 result |
| `review_repeat` | `buyer` | Rebook easily | secondary | Repeat rate is the key health signal | Repeat rate; cohort retention (newer ≥ older) |
| `dispute` | `buyer` / `ops` | Get a problem fixed | secondary | Trust between strangers | Resolution time; dispute rate |
| `liquidity_ops` | `ops` | Fill empty markets | edge | Liquidity is local | Match rate by geography |

#### steps: supply_onboarding

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Supplier landing (earnings calculator, "no fee until you earn") | Starts application | Removes risk objections | Application starts | [Rachitsky Part 3](https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-911) |
| 2 | Profile / verification (ID, payout) | Submits | Trust requirement; defer non-essential fields | Verification completion | synthesis |
| 3 | Listing builder with templates and price suggestions | Publishes | A live listing is supply activation | Draft → published rate | synthesis |
| 4 | Ops review queue | Ops approves | Quality gate | Approval time | synthesis |

#### steps: demand_search_book

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Search, geo/category prefilled | Searches | Keep buyers inside a dense atomic network | Zero-result rate | [a16z](https://a16z.com/13-metrics-for-marketplace-companies/) |
| 2 | Results with reviews, badges, price | Opens a listing | Trust before paying | Listing view → checkout | synthesis |
| 3 | Checkout via platform payment / escrow | Books or pays | Protects both sides; anchors take rate | Match rate; time to match | [a16z](https://a16z.com/13-metrics-for-marketplace-companies/) |
| 4 | Post-fulfilment review (both sides) | Rates | Builds the reputation layer | Review rate | synthesis |

#### standard_layout

| element | placement | why | basis |
|---|---|---|---|
| Earnings / zero-risk messaging | Supplier landing | Supply is usually the constraint | [Rachitsky](https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-9ee) |
| Geo/category-scoped search | Buyer home | Liquidity is local | [a16z](https://a16z.com/13-metrics-for-marketplace-companies/); [Rekhi/Chen](https://www.sachinrekhi.com/p/andrew-chen-the-cold-start-problem) |
| Reviews + verification | Listing page | Trusting a stranger | synthesis |
| On-platform payment | Checkout | Trust and take rate | synthesis |

#### drop_off_points

| step | drop_off | data | source |
|---|---|---|---|
| `supply_onboarding.2` | Verification abandoned | no public data | gap |
| `supply_onboarding.3` | Draft never published | no public data | gap |
| `demand_search_book.1` | Zero-result searches | named as the key lens; no benchmark | [a16z](https://a16z.com/13-metrics-for-marketplace-companies/) |

### template: ecommerce_checkout

Baymard averages **70.22% cart abandonment across 50 studies**. Among US shoppers who intended to buy, the top reasons were extra costs (40%), slow delivery (20%), distrust of the site with card details (19%), forced account creation (18%) and long checkouts (17%). Baymard estimates better checkout design could lift conversion about 35% for large sites ([Baymard, 2025](https://baymard.com/lists/cart-abandonment-rate)). Older survey editions put unexpected costs at 48% and forced accounts at 24–26%, so **always record the survey year** ([Baymard blog](https://baymard.com/blog/reduce-cart-abandonment)).

#### personas

| persona_id | persona | goal |
|---|---|---|
| `decided_buyer` | Mission shopper | "Pay and get a delivery date in under two minutes." |
| `cost_comparer` | Price-sensitive comparer | "Know the full price before committing." |
| `returning_customer` | Loyal returning customer | "Reorder in a few taps." |

#### journeys

| journey_id | persona | goal | priority | why | signal |
|---|---|---|---|---|---|
| `pdp_to_cart` | `decided_buyer` | Add the right item | core | Answer delivery and returns doubts before checkout | Add-to-cart per product-page view |
| `cart_review` | `cost_comparer` | See the total | core | Extra costs are the #1 abandonment reason | Cart → checkout rate |
| `guest_checkout` | `decided_buyer` | Pay fast | core | Forced accounts, length and distrust each drive abandonment | Checkout start → order |
| `post_purchase` | `decided_buyer` | Know when it arrives | secondary | Account creation after purchase keeps checkout fast | Post-purchase account creation; WISMO contacts |
| `express_reorder` | `returning_customer` | Reorder | secondary | Saved details remove fields | Repeat purchase rate |
| `cart_recovery` | `cost_comparer` | Come back later | edge | 42% were "just browsing" | Recovered-cart rate |

#### steps: guest_checkout

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Account step | Chooses "Guest checkout" (top, first viewport) | Forced accounts cause 18% of abandonment; a hidden guest option is as bad as none | Guest selection rate | [Baymard](https://baymard.com/blog/make-guest-checkout-prominent) |
| 2 | Contact + shipping (autocomplete) | Enters ~7–8 fields | The ideal is 12–14 form elements vs a 23.48 average | Field error rate | [Baymard](https://baymard.com/lists/cart-abandonment-rate) |
| 3 | Delivery method with dates | Picks delivery | Slow delivery causes 20% | Step drop-off | [Baymard](https://baymard.com/lists/cart-abandonment-rate) |
| 4 | Payment (wallets first, trust badges) | Pays | Distrust 19%; too few payment methods 9% | Decline rate | [Baymard](https://baymard.com/lists/cart-abandonment-rate) |
| 5 | Review with full total | Places order | Seeing the total 12%; extra costs 40% | `rev.checkout_completion` | [Baymard](https://baymard.com/lists/cart-abandonment-rate) |

#### steps: pdp_to_cart and cart_review

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Product page (price, variants, delivery estimate, returns summary) | Selects variant, adds to cart | Pre-empts delivery (20%) and returns (13%) doubts | Add-to-cart rate | [Baymard](https://baymard.com/lists/cart-abandonment-rate) |
| 2 | Mini-cart / toast | Chooses "Checkout" or continue shopping | Keeps momentum | Toast → checkout | synthesis |
| 3 | Cart (subtotal, shipping estimate, tax, collapsed promo) | Proceeds | Show cost early; a collapsed promo field avoids coupon hunting | Cart → checkout | [Baymard](https://baymard.com/lists/cart-abandonment-rate); promo detail synthesis |

#### standard_layout

| element | placement | why | basis |
|---|---|---|---|
| Guest checkout | Top of the account step | Forced accounts drive abandonment | [Baymard](https://baymard.com/blog/make-guest-checkout-prominent) |
| Full cost | Cart, before checkout | #1 abandonment reason | [Baymard](https://baymard.com/lists/cart-abandonment-rate) |
| Short form | ~7–8 fields | Length/complexity 17% | [Baymard](https://baymard.com/lists/cart-abandonment-rate) |
| Account offer | After purchase | Keeps guest checkout fast | synthesis |

#### drop_off_points

| step | drop_off | data | source |
|---|---|---|---|
| `cart_review.3` | Extra costs | 40% of intending buyers (2025) | [Baymard](https://baymard.com/lists/cart-abandonment-rate) |
| `guest_checkout.1` | Forced account | 18% (2025); 24–26% older editions | [Baymard](https://baymard.com/lists/cart-abandonment-rate) |
| `guest_checkout.*` on mobile | Mobile abandonment | ~80.0% vs desktop ~66.4% **conflicts with** 85.65% vs 73.07% (snippets) | [Baymard](https://baymard.com/lists/cart-abandonment-rate) (snippet) — contested |

### template: devtool_api

This is Ruah's own category. The developer journey runs from docs, to a key, to a first successful call in test mode, to a working app, to production, to team and billing ([Postman, 2021](https://blog.postman.com/the-most-important-api-metric-is-time-to-first-call/); [Moesif, 2022](https://www.moesif.com/blog/technical/api-analytics/Mastering-API-Analytics-for-API-Programs-Chapter-1/)). **Missing documentation was the top obstacle to consuming APIs (54.3%)** in Postman's 2020 survey ([HackerNoon summary](https://hackernoon.com/54percent-of-developers-cite-lack-of-documentation-as-the-top-obstacle-to-consuming-apis-2v4w3e30)). Stripe-style practices exist to shrink the time to first call: test mode, request logs, a CLI, keys injected into docs, and friction logging ([Auchenberg, 2024](https://kenneth.io/post/insights-from-building-stripes-developer-platform-and-api-developer-experience-part-1)).

#### personas

| persona_id | persona | goal |
|---|---|---|
| `individual_dev` | Individual developer (evaluator/builder) | "Get a working call or integration fast, with no sales contact." |
| `team_lead` | Team lead / engineering manager | "Standardise on the tool and control keys, environments and cost." |
| `security_reviewer` | Platform / security reviewer | "Approve for production safely." |

#### journeys

| journey_id | persona | goal | priority | why | signal |
|---|---|---|---|---|---|
| `docs_to_key` | `individual_dev` | Evaluate and get access | core | Developers judge the product by its docs | Quickstart view → signup → key |
| `first_call` | `individual_dev` | See it work | core | Time to first call is the key activation metric | `act.time_to_first_call`; % of signups with a 2xx within 1 day |
| `integrate` | `individual_dev` | Build the real feature | core | Bridges hello world to a working app | Time to first working app |
| `go_live` | `individual_dev` / `security_reviewer` | Ship to production | secondary | Security and money gate production | First live call; approval time |
| `team_billing` | `team_lead` | Roll out to the team | secondary | Several developers per account predicts stickiness (inferred) | Active developers per account; 28-day active companies |

#### steps: docs_to_key and first_call

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Public docs / quickstart (no login wall) | Reads the quickstart | Docs are the top blocker; evaluation happens by reading | Quickstart views | [Postman 2020 via HackerNoon](https://hackernoon.com/54percent-of-developers-cite-lack-of-documentation-as-the-top-obstacle-to-consuming-apis-2v4w3e30) |
| 2 | Signup (GitHub/Google OAuth) | Creates account | Less friction | Signup rate | synthesis |
| 3 | Dashboard with test key visible | Copies test key | Test keys separate from live keys make exploring safe | Key created | [Moesif teardown](https://www.moesif.com/blog/best-practices/api-product-management/the-stripe-developer-experience-and-docs-teardown/) (snippet) |
| 4 | Quickstart with the key pre-filled / try-it console / CLI | Runs the call | Ready-to-run examples cut TTFC 1.7x–56x | First 2xx; TTFC | [Postman, 2023](https://blog.postman.com/improve-your-time-to-first-api-call-by-20x/) |
| 5 | Request log | Inspects request/response | Teaches the object model; errors are how developers learn | Error → retry success | [Auchenberg](https://kenneth.io/post/insights-from-building-stripes-developer-platform-and-api-developer-experience-part-1) |

#### steps: integrate and go_live

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Sample apps / SDK / webhooks with CLI forwarding | Builds the feature locally | Tools in the developer's own environment | Webhook configured; time to first working app | [Auchenberg](https://kenneth.io/post/insights-from-building-stripes-developer-platform-and-api-developer-experience-part-1); [Moesif](https://www.moesif.com/blog/technical/api-analytics/Mastering-API-Analytics-for-API-Programs-Chapter-1/) |
| 2 | Go-live checklist (live and restricted keys) | Switches to live | Deliberate gate for money and security | First live call | [Moesif teardown](https://www.moesif.com/blog/best-practices/api-product-management/the-stripe-developer-experience-and-docs-teardown/) (snippet) |
| 3 | Security docs / scopes / audit log | Reviewer approves | Compliance delay is a named stall | Approval time | [Moesif](https://www.moesif.com/blog/technical/api-analytics/Mastering-API-Analytics-for-API-Programs-Chapter-1/) |

#### standard_layout

| element | placement | why | basis |
|---|---|---|---|
| Docs as landing | Public, before signup | Evaluation by reading | [Postman](https://blog.postman.com/the-most-important-api-metric-is-time-to-first-call/) |
| Test mode + test keys | Before any payment/KYC | First call in minutes | [Auchenberg](https://kenneth.io/post/insights-from-building-stripes-developer-platform-and-api-developer-experience-part-1) |
| Keys injected into code samples | Docs, when logged in | Copy-paste works first time | [Moesif teardown](https://www.moesif.com/blog/best-practices/api-product-management/the-stripe-developer-experience-and-docs-teardown/) (snippet) |
| Request log | Dashboard | Debugging is the main drop-off | [Auchenberg](https://kenneth.io/post/insights-from-building-stripes-developer-platform-and-api-developer-experience-part-1) |
| Go live | Separate step | Security review and money | synthesis |

#### drop_off_points

| step | drop_off | data | source |
|---|---|---|---|
| `docs_to_key.1` | Docs don't answer the first question | 54.3% cite missing docs as the top obstacle (2020) | [HackerNoon/Postman](https://hackernoon.com/54percent-of-developers-cite-lack-of-documentation-as-the-top-obstacle-to-consuming-apis-2v4w3e30) |
| `first_call.4` | First call fails (4xx) with an unclear error | no funnel % published | gap |
| `integrate` → `go_live` | Stall between sandbox and production | named (priorities, compliance); no % | [Moesif](https://www.moesif.com/blog/technical/api-analytics/Mastering-API-Analytics-for-API-Programs-Chapter-1/) |

### template: social_content

Roughly **90% of users lurk, 9% contribute occasionally and 1% create most content** ([Nielsen, 2006](https://www.nngroup.com/articles/participation-inequality/)), so consumer and creator journeys must be separate. A new user's graph and feed start empty, which is the cold-start problem. Onboarding therefore fills the feed through topic picks or contact import before asking the user to post ([Lenny on Chen, 2021](https://www.lennysnewsletter.com/p/atomic-network)). Pinterest found that moving a gender question out of sign-up improved activation, and that localised interest options improved activation abroad by 5–10% ([Pinterest Engineering](https://medium.com/pinterest-engineering/exploring-effective-user-signals-585507d8e926)).

#### personas

| persona_id | persona | goal |
|---|---|---|
| `lurker` | Consumer / lurker (~90%) | "Find stuff I like within seconds." |
| `contributor` | Casual contributor (~9%) | "Connect with people and get some response." |
| `creator` | Creator (~1%, the hard side) | "Grow an audience with minimal effort." |

#### journeys

| journey_id | persona | goal | priority | why | signal |
|---|---|---|---|---|---|
| `signup_interests` | `lurker` | Get to a good feed | core | Every pre-signup question costs conversions | Signup completion; topics picked |
| `first_feed` | `lurker` | Enjoy it now | core | The product must feel alive before a graph exists | Time to first like/save; D1 |
| `build_graph` | `contributor` | Connect with friends | core | Atomic network threshold | N connections in first days (calibrate) |
| `first_post` | `creator` / `contributor` | Share something | secondary | Early feedback rewards the first post | % posting within 7 days; feedback on first post |
| `notification_return` | all | Come back | secondary | Social push is the natural trigger; over-sending risks opt-out | Push opt-in; disable rate |

#### steps: signup_interests and first_feed

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Sign-up (SSO/phone), minimal profile | Signs up | Defer extra questions until after signup | Signup completion | [Pinterest](https://medium.com/pinterest-engineering/exploring-effective-user-signals-585507d8e926) |
| 2 | Topic / account picker (3–5) | Picks interests | Fills the feed; avoids an empty state; few steps | Topics picked | [Appcues on Pinterest](https://medium.com/appcues/casey-winters-reveals-how-pinterest-perfected-user-onboarding-639fcc7486d7) |
| 3 | Notification primer | Allows pushes after context is given | Protects the channel | Opt-in rate | synthesis; [Duolingo via Lenny](https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth) |
| 4 | Personalised feed | Scrolls, likes, saves | First value without a graph | Time to first like; D1 | [Lenny on Chen](https://www.lennysnewsletter.com/p/atomic-network) |

#### steps: first_post

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | "+" create (centre tab) | Captures or uploads | Always reachable for the 1–10% who create | Create-tab opens | [Nielsen 90-9-1](https://www.nngroup.com/articles/participation-inequality/) |
| 2 | Editor / templates | Edits, captions, picks audience | Lowers effort | Draft → post | synthesis |
| 3 | Post + activity tab | Receives likes/comments as notifications | Early feedback loop | Feedback on first post within 24 h | synthesis |

#### standard_layout

| element | placement | why | basis |
|---|---|---|---|
| Feed | Home | Most users consume | [Nielsen, 2006](https://www.nngroup.com/articles/participation-inequality/) |
| Create "+" | Centre tab / floating | Reachable for the creating minority | synthesis |
| Activity tab | Bottom nav | Feedback loop that brings people back | synthesis |

#### drop_off_points

| step | drop_off | data | source |
|---|---|---|---|
| `signup_interests.1` | Extra questions at sign-up | qualitative; moving them after signup improved activation | [Pinterest](https://medium.com/pinterest-engineering/exploring-effective-user-signals-585507d8e926) |
| `signup_interests.2` | Long onboarding | qualitative; kept to a few steps | [Appcues](https://medium.com/appcues/casey-winters-reveals-how-pinterest-perfected-user-onboarding-639fcc7486d7) |
| `first_feed.4` | Empty or irrelevant feed | no public % | gap |

### template: subscription_mobile

The first session decides revenue. **55.4% of 3-day-trial cancellations happen on Day 0**, hard paywalls convert about five times better than freemium by Day 35 (10.7% vs 2.1%), and longer trials convert better (42.5% vs 25.5%) ([RevenueCat, 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026)). Adapty's 16,000-app sample puts **89.4% of trial starts on Day 0** and trial-to-paid at 25.6% overall ([Adapty, 2026](https://adapty.io/state-of-in-app-subscriptions/)). Retention then comes from habit mechanics. At Duolingo, work on current-user retention raised CURR 21% and grew DAU 4.5x over about four years, leagues raised learning time 17%, and a referral programme added only about 3% new users ([Mazal via Lenny, 2023](https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth)).

#### personas

| persona_id | persona | goal |
|---|---|---|
| `motivated_starter` | Motivated starter (fresh resolution) | "Start a plan that fits me and stick with it." |
| `price_skeptic` | Price-skeptical explorer | "See if it's worth it without being tricked." |
| `lapsed_returner` | Lapsed returner | "Get back in without shame or starting over." |

#### journeys

| journey_id | persona | goal | priority | why | signal |
|---|---|---|---|---|---|
| `questionnaire_plan` | `motivated_starter` | Get my plan | core | Investment and personalisation before asking for money | Questionnaire completion; time to plan |
| `first_value` | `motivated_starter` | Finish one session | core | First-session activation | % of installs completing a core action on Day 0 |
| `paywall_trial` | `price_skeptic` | Decide whether to pay | core | Trials cluster on Day 0 | Install → trial; Day-0 cancellation |
| `daily_habit` | `motivated_starter` | Keep going | core | Streaks drive retention | D1/D7/D30; share of DAU on 7+ day streaks |
| `trial_convert` | `price_skeptic` | Keep it or not | secondary | Value recap before billing | `rev.mobile_trial_to_paid` |
| `win_back` | `lapsed_returner` | Come back | secondary | Reactivated and resurrected states are distinct levers | Reactivation rate |

#### steps: questionnaire_plan and paywall_trial

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Goal question ("Why are you here?") | Picks a goal | Commitment and personalisation | Answer rate | synthesis (industry pattern; no primary A/B data) |
| 2 | Level + daily time | Answers | Plan fit | Questionnaire completion | synthesis |
| 3 | "Your plan" summary | Reviews plan | Perceived value before price | Plan view → paywall view | synthesis |
| 4 | Paywall, annual highlighted, trial timeline (today / reminder / billed) | Starts trial | Trials start on Day 0; a transparent timeline reassures the skeptic | Paywall → trial; Day-0 cancels | [RevenueCat](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026); [Adapty](https://adapty.io/state-of-in-app-subscriptions/) |

#### steps: daily_habit

| # | screen | action | why | signal | basis |
|---|---|---|---|---|---|
| 1 | Reminder push at the chosen time | Opens the app | External trigger; protect the channel from opt-out | Push open rate; disable rate | [Duolingo via Lenny](https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth) |
| 2 | Today's session (single CTA) | Completes it | One obvious next action | Session completion | synthesis |
| 3 | Streak / league update | Sees progress | Streaks were the strongest engagement mechanic | Share of DAU on 7+ day streak | [Duolingo via Lenny](https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth) |
| 4 | Streak-at-risk / freeze | Saves the streak | Loss aversion protects the habit | Streak saves; reactivations | [Duolingo via Lenny](https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth) |

#### standard_layout

| element | placement | why | basis |
|---|---|---|---|
| Paywall | End of Day-0 onboarding, not first launch | User has invested; trial starts cluster on Day 0 | [RevenueCat](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026) |
| Home = "today" | Single primary CTA | One daily action | synthesis |
| Streak counter | Visible on home | Something to lose | [Duolingo via Lenny](https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth) |

#### drop_off_points

| step | drop_off | data | source |
|---|---|---|---|
| `paywall_trial.4` | Day-0 trial cancellation | 55.4% of 3-day-trial cancels on Day 0; 84% by Day 1 | [RevenueCat, 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026) |
| `trial_convert` | Annual plan churn | 35% of annual cancellations in month 1 | [RevenueCat, 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026) |
| `win_back` | Involuntary churn | Google Play billing 31% of cancellations vs App Store 14% | [RevenueCat, 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026) |

---

## 5. The agent asks; the builder answers with evidence

No source publishes a stage-by-stage coaching question bank, so **the bank below is Ruah synthesis**. Each question is attributed to the framework it adapts: Working Backwards' five questions, Mom Test probes, the Four Forces, switch interviews, Torres's five assumption types, and Doshi's pre-mortem ([Lenny's Podcast, Doshi](https://www.lennysnewsletter.com/p/episode-3-shreyas-doshi)). The agent's rule is fixed. **It never writes `steps[].why` itself.** It asks questions and offers the template from section 2. It fills fields only from the builder's answers or attached evidence, and it records unanswered questions in `steps[].question`. Gilad's ranking of opinion as near-zero confidence supports this: an agent-written why is by construction an opinion ([Gilad](https://itamargilad.com/the-tool-that-will-help-you-choose-better-product-ideas/)).

### question_bank

| question_id | stage | question | target_field | basis |
|---|---|---|---|---|
| `q.core.who` | any | Who exactly is on this step, and in what situation ("when…")? | `persona`, `steps[].why` | Job stories; PR-FAQ Q1 |
| `q.core.before_after` | any | What were they trying to get done just before this step, and just after? | `steps[].why` | Switch timeline |
| `q.core.problem` | any | What problem does this step solve for them, as opposed to for us? | `steps[].why` | PR-FAQ Q2 |
| `q.core.how_know` | any | How do we know? Point to a conversation, ticket or data point, with a date. | `steps[].evidence[]` | PR-FAQ Q4 |
| `q.core.workaround` | any | What did they do before this existed? | `evidence` (tag `workaround`) | Mom Test "what else have you tried" |
| `q.core.signal` | any | What would we see if this step were working, by how much, and by when? | `steps[].signal` | North Star inputs |
| `q.core.falsify` | any | What would convince us we are wrong? Imagine it failed; why? | `steps[].question` | Doshi pre-mortem |
| `q.core.risk_type` | any | Which is riskiest here: desirability, usability, feasibility, viability or ethics? | `steps[].question` | Torres assumption types |
| `q.core.problem_vs_solution` | any | Is this a problem or a solution? Could another design meet the same need? | `steps[].why` | Torres OST |
| `q.acq.trigger` | acquisition | What happened in someone's life the day they went looking for a tool like this? What did they search for? | `journey.why` | Moesta switch interview |
| `q.acq.push_pull` | acquisition | Which push from their current setup brings them here, and which pull does this screen promise? | `steps[].why` | Four Forces |
| `q.acq.source` | acquisition | Where did the last three real users come from? Is there a dated record? | `evidence` | YC "talk to users" |
| `q.acq.doubt` | acquisition | What claim on this screen would a new visitor doubt? | `steps[].question` | Four Forces (anxiety) |
| `q.act.first_value` | activation | What is the first moment of value, and how many steps does it take to reach it today? | `journey.signal` | Superhuman/Reforge aha stage |
| `q.act.habit_cost` | activation | What must the user stop doing or give up to adopt this? | `steps[].why` | Four Forces (habit) |
| `q.act.anxiety` | activation | What fear might stop them here (data access, cost, lock-in)? Is there a quote showing it? | `evidence` | Four Forces (anxiety) |
| `q.act.last_stuck` | activation | Tell me about the last user who got stuck here. What did they do instead? | `evidence` | Migicovsky "last time" |
| `q.act.rate_window` | activation | What share of new users reach this step, and within what time? | `steps[].signal` | `act.activation_rate` |
| `q.act.by_hand` | activation | Have you walked a user through this by hand? What did you have to explain? | `evidence` | Graham DTTDS; Superhuman |
| `q.core_action.job` | core_action | Write the job: "When…, I want to…, so I can…" | `steps[].why` | Klement job stories |
| `q.core_action.old_way` | core_action | Is the old workaround still used alongside this? | `evidence` | Mom Test |
| `q.core_action.say_do` | core_action | Is the evidence for this design stated preference or observed behaviour? | evidence `kind` | Nielsen |
| `q.core_action.frequency` | core_action | How often does the job naturally occur: daily, weekly, monthly? | `steps[].signal` window | Alströmer natural frequency |
| `q.ret.week2` | retention | What brings someone back in week two? Name a user and a date. | `evidence` | Alströmer repeat usage |
| `q.ret.competitor_job` | retention | What else competes for the same job between sessions (the "bananas and doughnuts")? | `steps[].why` | Milkshake case |
| `q.ret.leading_churn` | retention | What behaviour here predicts that someone is about to leave? | `steps[].signal` | Duolingo at-risk states |
| `q.ref.real_intro` | referral | Has anyone actually introduced us to someone else? | `evidence` (commitment: reputation) | Mom Test commitment |
| `q.ref.worth_risk` | referral | What would a user need to experience here to stake their reputation on recommending it? | `steps[].why` | Mom Test |
| `q.ref.data_vs_nps` | referral | Do we have referral data, or only "I'd recommend it"? | evidence `kind` | NPS critique |
| `q.rev.money_source` | revenue | Where does the money come from, and who signs off? | `persona` (approver) | Mom Test B2B question |
| `q.rev.already_paid` | revenue | What have they already paid (time, tools, contractors) to solve this? | `evidence` | Mom Test |
| `q.rev.commitment` | revenue | Any commitment signal: pilot, LOI, pre-order, paid upgrade? | evidence `kind: commitment` | Mom Test |
| `q.rev.viability` | revenue | What viability assumption would break the business case for this step? | `steps[].question` | Torres (viability) |

### red_flags

Each detection rule is Ruah synthesis. The rationale column cites the principle it enforces.

| flag_id | severity | trigger (detection) | message to builder | basis |
|---|---|---|---|---|
| `rf.why_missing` | high | `steps[].why` empty on a `priority: core` journey | This core step has no reason. Answer `q.core.*`. | PR-FAQ |
| `rf.opinion_language` | high | why contains "obviously", "everyone", "we assume", "users want" and has no evidence | Opinion, not evidence. | [Gilad](https://itamargilad.com/the-tool-that-will-help-you-choose-better-product-ideas/) |
| `rf.solution_as_why` | medium | why describes a UI element or feature rather than a problem | The why names a solution; what problem does it solve? | [Torres](https://www.producttalk.org/opportunity-solution-trees/) |
| `rf.competitor_only` | medium | only justification is "X has it" | Thematic support is weak. | [Gilad](https://itamargilad.com/the-tool-that-will-help-you-choose-better-product-ideas/) |
| `rf.single_request` | medium | 1 evidence item and it is a feature request | One request is bad data; dig into the motive. | [Mom Test notes](https://www.khanna.law/notes/the-mom-test) |
| `rf.stated_only` | medium | every evidence item is `stated_preference` / `hypothetical` | Stated preference ≠ behaviour. | [Nielsen](https://www.nngroup.com/articles/first-rule-of-usability-dont-listen-to-users/) |
| `rf.fluff_quote` | low | quote contains "would", "will", "might", "always", "usually" | Future or generic statement; ask for the last specific time. | [Mom Test notes](https://www.khanna.law/notes/the-mom-test) |
| `rf.compliment_quote` | low | quote like "love it", "great idea" | Compliments signal pitching, not learning. | [Mom Test notes](https://www.khanna.law/notes/the-mom-test) |
| `rf.evidence_undated` | medium | evidence has no `date` or `source` | Can't judge relevance; add source and date or move it to `question`. | Ruah contract |
| `rf.evidence_stale` | low | all evidence predates the step's last code change or a major redesign | Evidence may no longer describe this design. | Nygard (stale records) |
| `rf.single_segment` | low | all evidence from one persona/account presented as general | Over-indexing risk. | [Torres](https://www.producttalk.org/opportunity-solution-trees/) |
| `rf.contradiction_ignored` | high | evidence tagged `contradicts` with no reply or change | Confirmation bias. | [Nielsen](https://www.nngroup.com/articles/first-rule-of-usability-dont-listen-to-users/) |
| `rf.signal_missing` | medium | `steps[].signal` empty on a core step | Can't tell whether it works. | [Amplitude](https://amplitude.com/blog/good-bad-north-star-metric) |
| `rf.vanity_signal` | medium | signal is page views, registrations, visits, NPS | Measure repeat value, not a one-off event. | [Alströmer](https://www.ycombinator.com/blog/startup-school-week-4-recap-kat-manalac-and-gustaf-alstromer/) |
| `rf.signal_no_window` | low | signal lacks a threshold or time window | A retention target without a window is meaningless. | stage_metrics synthesis |
| `rf.signal_why_mismatch` | medium | signal does not measure the why's outcome clause | Rationale and metric are disconnected. | job story outcome clause |
| `rf.no_aha_step` | medium | core journey with no step marked as first value | Where does the user first get value? | [First Round](https://review.firstround.com/superhuman-onboarding-playbook/) |
| `rf.long_path_to_value` | low | more than ~5 steps or any branch before the first-value step | Opinionated onboarding: one default path. | [First Round](https://review.firstround.com/superhuman-onboarding-playbook/) (threshold is Ruah's) |
| `rf.invite_before_value` | low | invite step precedes first value in a product with single-player value | The invitee lands on an empty workspace. | synthesis from Chen/Appcues |
| `rf.persona_unevidenced` | medium | persona with no linked evidence, or described only demographically | Personas come from behaviour and pain in customers' words. | [Vohra](https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/) |
| `rf.no_primary_persona` | low | many personas, no core journey concentrated on one | Deep well, not shallow crater. | [Graham](https://paulgraham.com/startupideas.html) |
| `rf.benchmark_as_target` | low | signal copies a benchmark figure verbatim | Benchmarks are context-bound; label source and year. | section 7 |

---

## 6. Interview notes become evidence in four steps, and contradictions surface automatically

The workflow combines the Mom Test's note-taking discipline, Torres's snapshot, and Tomer Sharon's atomic "nuggets" (an observation, its evidence and tags), which he built into WeWork's Polaris repository ([User Interviews Field Guide, 2025](https://www.userinterviews.com/ux-research-field-guide-chapter/atomic-research-nuggets)). The Mom Test note conventions and symbols come from secondary summaries and are not verified against the book text ([Pakten](https://dev.to/egepakten/what-i-learned-from-the-mom-test-chapter-8-running-the-process-242h); [Waterstone notes](https://waterstonefitness.notion.site/The-Mom-Test-Summary-And-Notes-946870b1df584bbf85f39a0138216721)).

### interview_workflow

| phase | action | output | field_mapping | basis |
|---|---|---|---|---|
| `prep` | Pick the "big three" learning questions for this batch, drawn from open `steps[].question` values | Interview guide | reads `steps[].question` | [Mom Test notes](https://www.khanna.law/notes/the-mom-test) |
| `interview` | Story-based: "Tell me about the last time…"; no pitching; probe feature requests for motive | Raw notes | — | [Torres](https://www.producttalk.org/interview-snapshot/); [Migicovsky](https://www.ycombinator.com/blog/startup-school-week-1-recap-kevin-hale-and-eric-migicovsky/) |
| `capture` | Verbatim quotes in quotation marks; emotions and hard constraints logged; own ideas in a separate section; tag pain / goal / obstacle / workaround / context / feature_request / money / person / follow_up | Tagged raw notes | candidate `evidence.quote` | [Pakten](https://dev.to/egepakten/what-i-learned-from-the-mom-test-chapter-8-running-the-process-242h); [Waterstone](https://waterstonefitness.notion.site/The-Mom-Test-Summary-And-Notes-946870b1df584bbf85f39a0138216721) |
| `clean` | ~5 minutes right after the call | Cleaned notes | — | [Pakten](https://dev.to/egepakten/what-i-learned-from-the-mom-test-chapter-8-running-the-process-242h) |
| `snapshot` | One page within the hour: quote, quick facts, opportunities, insights, experience map (15–25 min) | Interview snapshot file | `evidence.source` points to it | [Torres, 2024](https://www.producttalk.org/interview-snapshot/) |
| `nuggetize` | Split into atomic observations + quote + tags; attach each to a `journey.step` | Evidence records | `steps[].evidence[]` (`quote`, `source`, `date`) | [Sharon via User Interviews](https://www.userinterviews.com/ux-research-field-guide-chapter/atomic-research-nuggets) |
| `link` | Mark each record `supports` or `contradicts` the step's why; grade strength | Linked evidence | proposed `kind`, `strength`, `stance` | section 2 scale [Ruah synthesis] |
| `review` | Every 3–4 interviews: re-rank opportunities, close or open `question`s, update whys | Updated product.json | `steps[].why`, `steps[].question` | [Torres, 2023](https://www.producttalk.org/opportunity-solution-trees/) |

### evidence_record [Ruah synthesis]

The first three fields exist today in Ruah's `Evidence` type. The rest are proposed optional extensions; unknown fields are ignored under the contract, so they can be added without breaking readers.

```yaml
evidence:
  quote: "Last Tuesday I gave up at the model picker and went back to the terminal"  # verbatim, ≤ 600
  source: "Interview — p07 (solo dev, self-hosted), notes/2026-09-24-p07.md"         # who + channel + ref
  date: 2026-09-24                                                                     # ISO 8601
  # proposed optional extensions
  kind: past_behavior        # opinion | thematic | stated_preference | hypothetical | past_behavior | past_behavior_pattern | commitment | observed_behavior | launch_data
  strength: 3                # 0–7, section 2 scale
  tags: [obstacle, workaround]   # pain | goal | obstacle | workaround | context | feature_request | money | person | follow_up
  emotion: angry             # excited | angry | embarrassed | neutral
  commitment: none           # none | time | reputation | money
  stance: contradicts        # supports | contradicts
```

### contradiction_checks [Ruah synthesis]

| check_id | compares | detection | agent action | basis |
|---|---|---|---|---|
| `cc.say_do` | stated-preference evidence vs analytics/observed evidence on the same step | `stated_preference` quote supports the why while `observed_behavior` or metric evidence shows low use | Flag; ask which to trust; open a `question` | [Nielsen](https://www.nngroup.com/articles/first-rule-of-usability-dont-listen-to-users/) |
| `cc.design_vs_story` | the order or behaviour the step assumes vs the order in interview stories | stories describe a workaround or a different sequence from `steps[]` order | Propose a `branch` or step reorder as a question, never an edit | [Milkshake](https://therewiredgroup.com/case-studies/milkshakes/) |
| `cc.segment_split` | evidence from different personas | `supports` from one persona, `contradicts` from another | Suggest splitting into two journeys (two jobs) | [Milkshake](https://therewiredgroup.com/case-studies/milkshakes/) |
| `cc.why_signal` | why outcome clause vs `signal` | signal measures something the why doesn't claim | Ask for a matching signal | job stories |
| `cc.code_drift` | `touches` code changed after the newest evidence date / `reviewedAt` | git dates newer than evidence | Mark evidence possibly stale; request re-validation | Nygard |
| `cc.single_story` | why strength rests on one interview | only one `past_behavior` item | Mark the why tentative until 3–4 interviews | [Torres](https://www.producttalk.org/opportunity-solution-trees/) |
| `cc.request_vs_motive` | `feature_request` evidence vs the step it justifies | request present with no motive probe | Ask the three probes: why do you want it, how do you cope now, what would it let you do | [Mom Test notes](https://www.khanna.law/notes/the-mom-test) |

---

## 7. Several famous figures are contested, dated or apocryphal

Ruah should show every figure in this table with its status label and should never offer it as a default target.

| figure | status | why flagged | use in Ruah |
|---|---|---|---|
| Facebook "7 friends in 10 days" | contested | Chen summary gives "10 in 7"; Mixpanel calls magic numbers correlational storytelling ([Mixpanel](https://mixpanel.com/blog/magic-numbers-are-an-illusion/); [Rekhi](https://www.sachinrekhi.com/p/andrew-chen-the-cold-start-problem)) | Illustration of method only |
| Slack "2,000 messages → 93% retention" | unverified | Only in book summaries; no primary Slack source retrieved | Illustration only |
| Dropbox "one file in one folder on one device" | apocryphal | Widely repeated, no clear primary source found | Omit or label apocryphal |
| Slack PQL definition "2+ channels, invite ≥ 1, 2,000 messages" | likely conflated | Aggregators merge the activation stat with PQL criteria | Omit |
| Sean Ellis 40% "very disappointed" | contested | Heuristic, not statistically derived; Alströmer (YC) prefers retention | Offer with retention as a pair |
| PG 5–7% weekly growth | dated / context-bound | 2012, YC batch, venture-scale; criticised as gameable | Label "YC-batch, 2012" |
| DAU/MAU 20% social, 10–15% B2B | unverified | Aggregator; Mixpanel 2026 measures ~31% for B2B | Use Mixpanel figure |
| Lenny 6-month retention / NRR table | dated | 2020, 20 practitioners | Use with year |
| Visitor → signup (freemium vs trial) | conflicting | Lenny/OpenView ~6% / 3–4% vs OpenView snippet ~9% / ~5% | Show a range; mark as conflicting |
| Card-required trial 40–60% | unverified | Aggregators citing OpenView/ProfitWell | Omit until verified |
| Baymard mobile vs desktop abandonment | conflicting | 80.0/66.4 vs 85.65/73.07 in different snippets | Use the 70.22% average only |
| Baymard reason percentages | edition-dependent | 2025: costs 40%, account 18%; older: 48%, 24–26% | Always cite edition year |
| Milkshake "40% bought by morning commuters" | secondary | Not verified against the HBR text | Tell the story without the number |
| Adapty "Day-0 miss → 11% trial chance", "53% trial-to-paid" | conflicting | Contradicts Adapty's own 25.6% headline | Omit |
| Duolingo "10-day streak reduces drop-off" | secondary | Not verified at primary | Omit; use the sourced CURR/streak findings |
| "Onboarding completers retain 2–3x" | vendor, unattributed | Appcues claim with no study | Omit |
| "Top-quartile TTV < 5 min" | unverified | Snippet, not tied to the primary report | Omit |
| NPS as a growth predictor | contested | Replications find no advantage over other satisfaction measures ([Nunan, 2024](https://journals.sagepub.com/doi/10.1177/14707853241242228)) | Offer only with a caveat |
| Fed 94/58/56 banking activity | dated | November 2015 fieldwork | Label year; direction still consistent with later data |
| Signicat 68% abandonment | measure mismatch | Self-reported "abandoned at least one application", not a funnel rate | Label as a survey measure |
| First Round Levels thresholds | context-bound | B2B/enterprise ARR, NRR, burn | Use the qualitative signals for solo devs |
| a16z AI retention (M12/M3) | incomplete | Benchmark values not extracted | Cite the concept only |

---

## Conclusion

For Ruah, the most useful finding is that the canon's advice becomes enforceable once it is written as data. "Talk to users" and "don't trust opinions" are platitudes in an essay. Attached to a journey step, they become checks: whether the step has a `why`, whether that why rests on dated past-behaviour evidence rather than a quote containing "would", and whether its `signal` has a window that matches the job's natural frequency. Those are cheap, deterministic checks that a solo developer will not run on their own, and most of the red flags in section 5 can be implemented as lint rules without any model call. The model's real job is narrower than it first appears. It should ask the questions a coach would ask, turn interview notes into tagged evidence, and point out contradictions between what customers said, what they did and what the code now does. It should not write the rationale, because an agent-authored why is by definition opinion-grade evidence.

The second implication is about humility with numbers. Every stage has published ranges, but the ranges differ by model, year and sample, and the most quotable figures are the least reliable. A tool that pastes "activation ≥ 30%" into a signal field without a source and year would reproduce the benchmark-as-target error these sources warn against. The more defensible design has Ruah's templates carry the structure (personas, first-value step, invite placement, go-live gate), with labelled benchmarks as reference points, and relies on the builder's own interviews and analytics to turn each template's hypothetical why into a real one. For Ruah's own developer-tool journey, the templates point to a clear first test: measure the time from install to the first useful map or journey, capture the first dozen onboardings by hand as evidence, and run the 40% survey alongside a retention curve rather than choosing between them.

---

## Sources

**Y Combinator and founders**
- Paul Graham, "Do Things That Don't Scale" (2013): https://paulgraham.com/ds.html
- Paul Graham, "Startup = Growth" (2012): https://paulgraham.com/growth.html ; YC Library copy: https://www.ycombinator.com/library/8s-startup-growth
- Paul Graham, "How to Get Startup Ideas" (2012): https://paulgraham.com/startupideas.html
- YC blog, Startup School Week 1 Recap: Kevin Hale and Eric Migicovsky (2019): https://www.ycombinator.com/blog/startup-school-week-1-recap-kevin-hale-and-eric-migicovsky/
- YC blog, Startup School Week 4 Recap: Kat Mañalac and Gustaf Alströmer (2019): https://www.ycombinator.com/blog/startup-school-week-4-recap-kat-manalac-and-gustaf-alstromer/
- Secondary summary of Alströmer's talk (retention example): https://videohighlight.com/v/6lY9CYIY4pQ
- Michael Seibel, "The Real Product Market Fit": https://www.michaelseibel.com/blog/the-real-product-market-fit
- TechCrunch, "Growth as a false signal in Y Combinator startups" (2016): https://techcrunch.com/2016/12/18/growth-as-a-false-signal-in-y-combinator-startups/

**VCs and accelerators**
- Marc Andreessen, "The only thing that matters" (2007): https://pmarchive.com/guide_to_startups_part4.html
- Sequoia, "The Arc Product-Market Fit Framework" (2024): https://www.sequoiacap.com/article/pmf-framework/
- Rahul Vohra, First Round Review, "How Superhuman Built an Engine to Find Product/Market Fit" (2018): https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/
- First Round Review, "Superhuman onboarding playbook" (2025): https://review.firstround.com/superhuman-onboarding-playbook/
- First Round, "Levels of PMF" (2024): https://www.firstround.com/levels ; PMF Method: https://www.firstround.com/pmf
- First Round Review glossary, K-factor: https://review.firstround.com/glossary/k-factor-virality/
- Li Jin and Andrew Chen, a16z, "The Power User Curve" (2018): https://a16z.com/the-power-user-curve-the-best-way-to-understand-your-most-engaged-users/
- Rodriguez and Immerman, a16z, "Retention Is All You Need" (2025): https://a16z.com/ai-retention-benchmarks/
- Jordan, Jin, Coolican, Chen, a16z, "13 Metrics for Marketplace Companies" (2020): https://a16z.com/13-metrics-for-marketplace-companies/ ; Marketplace Glossary: https://a16z.com/the-marketplace-glossary/
- Techstars Entrepreneur's Toolkit, "Understand Your Customers": https://toolkit.techstars.com/understand-your-customers
- Andrew Chen, "Retention is king": https://andrewchen.com/retention-is-king/ ; "28 ways to grow supply in a marketplace": https://andrewchen.com/grow-marketplace-supply/
- Sachin Rekhi, primer on *The Cold Start Problem* (2021): https://www.sachinrekhi.com/p/andrew-chen-the-cold-start-problem
- Decibel VC on PQLs: https://www.decibel.vc/articles/product-qualified-leads-and-product-led-growth-lessons-from-slack-atlassian-and-zendesk

**Lenny Rachitsky**
- "What is a good activation rate" (2022): https://www.lennysnewsletter.com/p/what-is-a-good-activation-rate ; https://x.com/lennysan/status/1584923800226832384
- "What is good retention" (2020): https://www.lennysnewsletter.com/p/what-is-good-retention-issue-29
- "Monthly churn benchmarks" (2022): https://www.lennysnewsletter.com/p/monthly-churn-benchmarks
- "What is a good free-to-paid conversion" (~2023): https://www.lennysnewsletter.com/p/what-is-a-good-free-to-paid-conversion ; https://twitter.com/lennysan/status/1686421779479400448
- Marketplace series Part 2 (2019): https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-9ee ; Part 3: https://www.lennysnewsletter.com/p/how-to-kickstart-and-scale-a-marketplace-911 ; https://twitter.com/lennysan/status/1167088120132562945 ; https://www.lennysnewsletter.com/p/labor-marketplace-supply-growth
- "The Atomic Network" (2021): https://www.lennysnewsletter.com/p/atomic-network
- Jorge Mazal, "How Duolingo reignited user growth" (2023): https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth ; https://www.lennysnewsletter.com/p/the-secret-to-duolingos-growth
- Lenny's Podcast, Shreyas Doshi: https://www.lennysnewsletter.com/p/episode-3-shreyas-doshi ; Todd Jackson: https://www.lennysnewsletter.com/p/a-framework-for-finding-product-market

**Discovery, JTBD and evidence**
- The Mom Test: https://www.momtestbook.com/ ; secondary notes: https://www.khanna.law/notes/the-mom-test ; https://waterstonefitness.notion.site/The-Mom-Test-Summary-And-Notes-946870b1df584bbf85f39a0138216721 ; https://dev.to/egepakten/what-i-learned-from-the-mom-test-chapter-8-running-the-process-242h
- Re-Wired Group, milkshake case: https://therewiredgroup.com/case-studies/milkshakes/
- Christensen et al., HBR (2016): https://hbr.org/2016/09/know-your-customers-jobs-to-be-done ; IdeaCast: https://hbr.org/podcast/2016/12/the-jobs-to-be-done-theory-of-innovation
- Moesta and Spiek, The Four Forces: https://jobstobedone.org/the-four-forces/
- June.so, JTBD interview (2025): https://www.june.so/blog/how-to-run-a-jtbd-interview-like-the-co-creator-of-the-framework
- Alan Klement, job stories (2013): https://www.intercom.com/blog/using-job-stories-design-features-ui-ux/
- Teresa Torres, Opportunity Solution Trees (2023): https://www.producttalk.org/opportunity-solution-trees/ ; Interview Snapshot (2024): https://www.producttalk.org/interview-snapshot/ ; Five types of assumptions: https://www.producttalk.org/five-types-of-assumptions/ ; https://x.com/ttorres/status/1782787771188285800
- Jakob Nielsen, "First Rule of Usability" (2001): https://www.nngroup.com/articles/first-rule-of-usability-dont-listen-to-users/ ; "Participation Inequality" (2006): https://www.nngroup.com/articles/participation-inequality/
- Itamar Gilad, Confidence Meter: https://itamargilad.com/the-tool-that-will-help-you-choose-better-product-ideas/ ; https://itamargilad.com/how-much-product-discovery/
- Working Backwards PR-FAQ: https://workingbackwards.com/concepts/working-backwards-pr-faq-process/
- Michael Nygard, "Documenting Architecture Decisions" (2011): https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions
- User Interviews Field Guide, atomic research nuggets (2025): https://www.userinterviews.com/ux-research-field-guide-chapter/atomic-research-nuggets

**Analytics and benchmarks**
- Amplitude North Star Playbook: https://info.amplitude.com/rs/138-CDN-550/images/Amplitude-The-North-Star-Playbook.pdf ; https://amplitude.com/books/north-star/amplitudes-north-star-metric-and-inputs ; https://amplitude.com/blog/good-bad-north-star-metric
- Mixpanel, "Magic numbers are an illusion" (2026): https://mixpanel.com/blog/magic-numbers-are-an-illusion/ ; Benchmarks: https://mixpanel.com/benchmarks/ ; https://mixpanel.com/blog/mau/
- Mode, "Facebook's aha moment was simpler than you think": https://mode.com/blog/facebook-aha-moment-simpler-than-you-think/
- Unbounce conversion benchmarks: https://unbounce.com/landing-pages/whats-a-good-conversion-rate/ ; https://unbounce.com/average-conversion-rates-landing-pages/
- Userpilot TTV (2024): https://userpilot.com/blog/time-to-value-benchmark-report-2024/ ; checklist completion (2024): https://userpilot.medium.com/customer-onboarding-checklist-completion-rate-2024-benchmark-report-8ebabebefb1f ; 2025: https://userpilot.com/blog/onboarding-checklist-completion-rate-benchmarks/ ; product metrics: https://userpilot.com/blog/product-metrics-benchmark-report/
- UXCam mobile retention (2026): https://uxcam.com/blog/mobile-app-retention-benchmarks/
- SaaS Capital retention (2025): https://www.saas-capital.com/blog-posts/what-is-a-good-retention-rate-for-a-private-saas-company/
- RevenueCat State of Subscription Apps 2026: https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026 ; https://www.revenuecat.com/state-of-subscription-apps
- Adapty State of In-App Subscriptions 2026: https://adapty.io/state-of-in-app-subscriptions/
- OpenView 2022 Product Benchmarks: https://openviewpartners.com/2022-product-benchmarks/ ; PLG benchmarks guide: https://openviewpartners.com/blog/your-guide-to-product-led-growth-benchmarks/
- Kyle Poyar on reverse trials (2022): https://x.com/poyark/status/1537064035052568578
- Ipsos, "The Net Promoter Debate": https://www.ipsos.com/en-us/net-promoter-debate ; MeasuringU: https://measuringu.com/nps-discredited/ ; Nunan (2024): https://journals.sagepub.com/doi/10.1177/14707853241242228

**Category sources**
- Federal Reserve, Consumers and Mobile Financial Services 2016: https://www.federalreserve.gov/econresdata/mobile-devices/2016-executive-summary.htm
- Signicat, Battle to Onboard 2022: https://www.signicat.com/press-releases/the-battle-to-onboard-2022 ; https://www.signicat.com/the-battle-to-onboard-2022
- J.D. Power 2025 banking app satisfaction: https://www.jdpower.com/business/press-releases/2025-us-banking-and-credit-card-mobile-app-satisfaction-studies
- Monzo: https://monzo.com/blog/how-we-built-the-new-home-screen ; https://monzo.com/ie/help/using-monzo/help-home-screen ; https://monzo.com/help/app-help/finding-features-new-homescreen
- Baymard cart abandonment (2025): https://baymard.com/lists/cart-abandonment-rate ; guest checkout: https://baymard.com/blog/make-guest-checkout-prominent ; https://baymard.com/blog/reduce-cart-abandonment
- Appcues onboarding strategies (2026): https://www.appcues.com/blog/8-user-onboarding-strategies
- Dock, PQLs: https://www.dock.us/library/product-qualified-leads
- Pinterest Engineering, user signals: https://medium.com/pinterest-engineering/exploring-effective-user-signals-585507d8e926 ; Appcues on Pinterest: https://medium.com/appcues/casey-winters-reveals-how-pinterest-perfected-user-onboarding-639fcc7486d7
- Postman, time to first call (2021): https://blog.postman.com/the-most-important-api-metric-is-time-to-first-call/ ; 20x (2023): https://blog.postman.com/improve-your-time-to-first-api-call-by-20x/
- HackerNoon summary of Postman 2020 State of the API: https://hackernoon.com/54percent-of-developers-cite-lack-of-documentation-as-the-top-obstacle-to-consuming-apis-2v4w3e30
- Moesif developer funnel (2022): https://www.moesif.com/blog/technical/api-analytics/Mastering-API-Analytics-for-API-Programs-Chapter-1/ ; Stripe DX teardown: https://www.moesif.com/blog/best-practices/api-product-management/the-stripe-developer-experience-and-docs-teardown/
- Kenneth Auchenberg, Stripe developer platform (2024): https://kenneth.io/post/insights-from-building-stripes-developer-platform-and-api-developer-experience-part-1
