# Customer Discovery, Evidence-Backed Product Decisions, and the Customer-Interview Workflow

Scope: sourced guidance for Ruah's journey-step fields: **why** (rationale), **signal** (success metric), **evidence** (customer quote + source + date), **question** (open product question). The in-tool AI agent must not invent the why. It should ask questions and attach real evidence.

Research date: 2026-09-27. Several primary pages (momtestbook.com, itamargilad.com calculator, tsharon.medium.com, age-of-product.com) either did not include the substantive content or returned HTTP 403. Where that happened, reputable secondary summaries are cited and marked as secondary.

---

## (a) Interviewing customers without leading them: The Mom Test (Rob Fitzpatrick)

### Takeaway
The Mom Test says: talk about the customer's life, not your idea. Ask about specific past events, not opinions or the future. Talk less than you listen. Treat compliments, fluff (generic, future-tense or hypothetical statements) and feature requests as bad data. Only commitments that cost the customer time, reputation or money count as real signals of interest.

### Cited Findings
- **Author / source**: Rob Fitzpatrick, a YCombinator alum (S07). The book is a practical handbook for getting learning out of customer conversations "even when everyone is lying to you." — [momtestbook.com](https://www.momtestbook.com/) (landing page, no date; the book was first published in 2013)
- **Three rules** (secondary summary): (1) talk about their life, not your idea; (2) ask about specifics in the past, not generics or opinions about the future; (3) talk less and listen more. — [Khanna Law book notes, The Mom Test](https://www.khanna.law/notes/the-mom-test) (undated)
- **Good questions** (secondary): "Why do you bother?" finds the real motive. "What are the implications of that?" separates serious problems from minor annoyances. "What else have you tried?" reveals current solutions and switching cost. "Where does the money come from?" matters for B2B. "Who else should I talk to?" should close every conversation. — [Khanna Law notes](https://www.khanna.law/notes/the-mom-test)
- **Bad question forms**: "Do you ever…?", "Would you ever…?" and "What do you usually…?" produce hypotheticals or generics, not evidence. — [Khanna Law notes](https://www.khanna.law/notes/the-mom-test)
- **Three types of bad data**:
  - Compliments: a sign you've slipped into pitching. Deflect them.
  - Fluff: generic claims ("always", "usually"), future promises ("would", "will") and hypotheticals. Anchor back to a specific past instance.
  - Ideas and feature requests: don't put them straight on the roadmap. Dig into the motivation behind them.
  — [Khanna Law notes](https://www.khanna.law/notes/the-mom-test)
- **Digging into a feature request**: ask "Why do you want that?", "How are you coping without it?" and "What would that let you do?" These show whether the request reflects real pain or a nice-to-have. — [Khanna Law notes](https://www.khanna.law/notes/the-mom-test)
- **Commitment and advancement come in three currencies**:
  - Time: follow-up meetings, feedback sessions, trial use.
  - Reputation: intros to peers or decision-makers, public testimonials.
  - Money: letters of intent, pre-orders, deposits.
  — [Khanna Law notes](https://www.khanna.law/notes/the-mom-test)
- **Prep**: decide your "big three" learning questions before a batch of conversations and update them after each batch. — [Khanna Law notes](https://www.khanna.law/notes/the-mom-test)
- **Warning signs that you're only going through the motions**: you talk more than they do, you get compliments, you take no notes, or answers surprise you but change nothing. — [Khanna Law notes](https://www.khanna.law/notes/the-mom-test)
- **Note-taking symbols** (secondary summaries, consistent across several sources):
  - Emotions: `:)` excited, `:(` angry, `:|` embarrassed.
  - Life:
    - Pain/problem: lightning bolt (☇).
    - Goal/job-to-be-done: goalposts (⨅).
    - Obstacle: box (☐).
    - Workaround: curved arrow (⤴).
    - Background/context: mountain (^).
  - Specifics: feature request (checkbox), money ($), person (stick figure), follow-up (star).
  - Pains and obstacles weigh more when the person is visibly angry or embarrassed about them.
  — [Waterstone Mom Test notes (Notion)](https://waterstonefitness.notion.site/The-Mom-Test-Summary-And-Notes-946870b1df584bbf85f39a0138216721); [pkubelka.cz book notes](https://pkubelka.cz/posts/books/moms_test/) (surfaced in search, not fully fetched)
- **Note hygiene** (secondary, Ch. 8 summary):
  - Put exact quotes in quotation marks so they stay separate from your interpretation.
  - Record emotions and hard constraints (team size, budget, timeline).
  - Keep your own ideas in a separate section.
  - Spend about 5 minutes cleaning up notes right after the call.
  - Team review: share raw notes without editorializing, look for patterns across conversations, update assumptions, then decide on more interviews or building.
  — [Ege Pakten, DEV Community, "What I Learned from The Mom Test – Ch. 8"](https://dev.to/egepakten/what-i-learned-from-the-mom-test-chapter-8-running-the-process-242h) (March 11, year not shown)

### Inferences
- For Ruah's `evidence` field, a Mom-Test-compliant item needs:
  - a verbatim quote in quotation marks,
  - a specific past event (not "usually" or "would"),
  - a source (person/role and channel) and a date,
  - optional symbol tags that map cleanly to enums: `pain | goal | obstacle | workaround | context | feature_request | money | person | follow_up`, plus emotion `excited | angry | embarrassed`.
- The agent can lint an evidence quote for fluff. It should flag future or conditional verbs ("would", "will", "might"), generalizers ("always", "usually", "never") and compliment language ("love it", "great idea") as weak or stated-preference evidence.
- Commitment can become an evidence-strength attribute: `none | time | reputation | money`.

### Gaps
- I could not fetch the book text or the official site's chapter content. The rules, symbols and question lists come from secondary summaries. They agree with each other but are not verified verbatim.
- The exact names of Fitzpatrick's fluff sub-types (for example "anchoring fluff") and his "zombie lead" concept were not confirmed from a fetched source.

---

## (b) Jobs-to-be-Done: Christensen, Moesta/Re-Wired Group, job stories

### Takeaway
People "hire" products to make progress in a particular circumstance. The circumstance, not demographics, explains behavior. Switch interviews rebuild the timeline of a real past purchase or switch to expose four forces: Push + Pull must exceed Anxiety + Habit. Job stories ("When…, I want to…, so I can…") turn this into design units that carry their own rationale.

### Cited Findings
- **Milkshake case**:
  - The chain first acted on stated feedback (new flavors, different thickness). Sales did not move meaningfully.
  - Christensen and Moesta then found two jobs:
    - Morning commuters wanted something to keep them occupied and full on a long drive. Competitors were bananas, Snickers bars and doughnuts.
    - Afternoon parents were treating their children. Competitors were things like a toy-store visit.
  — [The Re-Wired Group, "Milkshakes in the Morning"](https://therewiredgroup.com/case-studies/milkshakes/) (case from *Competing Against Luck*; page undated)
- Christensen et al. published "Know Your Customers' 'Jobs to Be Done'" in HBR in September 2016. *Competing Against Luck* (HarperBusiness) came out in October 2016. — [HBR, Sept 2016](https://hbr.org/2016/09/know-your-customers-jobs-to-be-done); [HBR IdeaCast, Dec 2016](https://hbr.org/podcast/2016/12/the-jobs-to-be-done-theory-of-innovation)
- A secondary account says nearly 40% of the chain's shakes were bought by lone morning commuters, and that asking customers how to improve the product "got nowhere." — Christensen/milkshake summaries surfaced in search (for example [Ameet Ranadive, Medium](https://medium.com/pm-insights/jobs-to-be-done-milkshakes-and-online-learning-a0dd90a1ce20)). Not verified against the primary HBR text.
- **Four Forces of Progress** (Bob Moesta and Chris Spiek):
  - Push: friction with the current situation.
  - Pull: the picture of a better life with the new solution.
  - Anxiety: fear of the new.
  - Habit: comfort with the present.
  - A switch happens when Push + Pull > Anxiety + Habit. Teams have two objectives: raise push/pull and lower anxiety/habit. Most teams only work on attractiveness.
  — [jobstobedone.org, "The Four Forces"](https://jobstobedone.org/the-four-forces/) (Moesta & Spiek; page undated)
- **Switch interview timeline and questions** (secondary account of Moesta's method):
  - Stages: before purchase → first thought → struggle → solution search → decision → early experience → evolution → current state.
  - Example questions:
    - "What was happening the day you decided to search for a new tool?"
    - "What did you Google?"
    - "What made you decide this was the one?"
    - "When did you first realize this was the right choice?"
  - Tips:
    - Recruit a mix of recent customers, long-time users and lost deals.
    - Push past vague answers like "too complicated."
    - Frame questions around their experience, not your assumptions.
    - Follow their story.
  — [Enzo Avigo, June.so blog, Feb 17, 2025](https://www.june.so/blog/how-to-run-a-jtbd-interview-like-the-co-creator-of-the-framework)
- **Job stories**:
  - Format: "When [situation], [I] want to [motivation], so I can [expected outcome]."
  - They drop personas because persona attributes do not explain causality. They focus on situation, motivation and anxieties.
  - Example: a car-loan salesperson profile. Each element (photo, credentials, contact options) traces back to the job of helping the buyer feel safe sharing financial details.
  — [Alan Klement, Intercom blog, Dec 23, 2013](https://www.intercom.com/blog/using-job-stories-design-features-ui-ux/)

### Inferences
- A journey step's `why` can be framed as a job story: situation → motivation → outcome. The `signal` then measures the outcome clause.
- The Four Forces give the agent a checklist for any step that asks the user to adopt or switch (onboarding, import, upgrade):
  - What push does this step rely on?
  - What pull does it show?
  - What anxiety might block it?
  - What habit competes with it?
- The milkshake case shows that stated feedback ("make it thicker") can be wrong while observed circumstance and behavior are right.

### Gaps
- The standard Re-Wired timeline labels ("first thought → passive looking → event → active looking → deciding → consuming → satisfaction") were not confirmed from a primary Re-Wired page. The June.so version is a paraphrased variant.

---

## (c) Continuous discovery (Teresa Torres)

### Takeaway
Torres recommends:
- weekly customer touchpoints by the team that builds the product,
- story-based interviews about specific past experiences,
- a one-page interview snapshot after each interview,
- an opportunity solution tree (outcome → opportunities → solutions → assumption tests),
- testing the five assumption types behind every solution: desirability, viability, feasibility, usability, ethical.

### Cited Findings
- **Opportunity solution tree (OST)**:
  - Four layers: a desired outcome at the root, opportunities (customer needs, pain points, desires), solutions, and assumption tests.
  - Opportunities should come from story-based interviews, not from the team's heads, which bring in bias and half-truths.
  - Do at least 3–4 interviews before mapping. Update after every 3–4 more.
  - Test for a real opportunity: several different solutions could address it.
  - Compare at least three solutions for the target opportunity.
  - Interview weekly. Review the opportunity space every 3–4 weeks so one interview doesn't dominate.
  — [Teresa Torres, Product Talk, "Opportunity Solution Trees," Dec 6, 2023](https://www.producttalk.org/opportunity-solution-trees/)
- **Interview snapshot**:
  - One page per interview with:
    - name/photo,
    - quick facts (context),
    - a memorable quote,
    - opportunities (needs, pains, desires),
    - insights (interesting but not yet actionable),
    - an experience map sequencing the key moments of the story.
  - Build it right after the interview. A typical 20–30 minute interview is followed by 15–25 minutes of synthesis.
  — [Teresa Torres, Product Talk, "The Interview Snapshot," Feb 21, 2024](https://www.producttalk.org/interview-snapshot/)
- **Story-based interviewing**: collect specific stories about past behavior rather than asking directly about needs. Example prompt: "Tell me about the last time…" — [Torres, Interview Snapshot](https://www.producttalk.org/interview-snapshot/); Torres calls the technique "excavating the story" per a secondary source ([Shortform](https://www.shortform.com/blog/teresa-torres-customer-interviews/)).
- **Five assumption types**:
  - Desirability: will they want it?
  - Viability: does it make business sense?
  - Feasibility: can we build it?
  - Usability: can they use it?
  - Ethical: could it cause harm?
  — [Teresa Torres on X](https://x.com/ttorres/status/1782787771188285800); [Product Talk, "5 Types of Assumptions"](https://www.producttalk.org/five-types-of-assumptions/) (surfaced in search, not fully fetched)

### Inferences
- Map Torres's model onto Ruah fields:
  - The OST outcome becomes the step's `signal`.
  - An opportunity becomes the customer problem behind the `why`.
  - An interview snapshot's memorable quote becomes `evidence`.
  - Untested assumptions become `question`.
- The agent can tag each open `question` with one of the five assumption types. That shows which kind of risk is still open.
- The "3–4 interviews before mapping" rule suggests a minimum-evidence threshold. A `why` backed by a single interview should be marked tentative.

### Gaps
- I did not fetch the full *Continuous Discovery Habits* (2021) text. The weekly cadence and "product trio" details come from Product Talk articles, not the book.

---

## (d) What makes a good product "why" and strong vs weak evidence

### Takeaway
Evidence strength, strongest to weakest:
1. Observed or real-world behavior: launch data, test results.
2. Past behavior told in specific stories, plus commitments that cost time, reputation or money.
3. Anecdotes and market data.
4. Stated preferences and predictions.
5. Opinions: the team's own conviction, trends, a stakeholder's view.

A good "why" names the customer, their problem, how we know, and the metric that will show success.

### Cited Findings
- **Nielsen's first rule of usability**: watch what users do; don't believe what they say they do; certainly don't believe predictions of what they might do. Self-reports are distorted three ways: users tell designers what they want to hear, misremember, and rationalize after the fact. — [Jakob Nielsen, NN/g, Aug 4, 2001](https://www.nngroup.com/articles/first-rule-of-usability-dont-listen-to-users/)
- **Stated preference vs performance**:
  - Across 113 UI comparisons, measured performance and stated preference correlated at only 0.44 (0.53 in a later website study).
  - Nielsen notes that satisfaction predicts performance only about 25% of the time.
  - Survey claims that people would buy from sites with 3-D product views only show the idea sounds appealing.
  — [Nielsen, NN/g, 2001](https://www.nngroup.com/articles/first-rule-of-usability-dont-listen-to-users/)
- **Itamar Gilad's Confidence Meter**:
  - Scores confidence in an idea from 0 to 10 based on the type of evidence.
  - Weakest: self-conviction, thematic support (trends), others' opinions. These yield near-zero or low confidence; the tool treats opinion as unreliable.
  - Middle: estimates and plans, anecdotal evidence (a handful of customers), market data.
  - Strongest: user/customer evidence (interviews, prototype tests), test results (such as MVP usage), launch data.
  - Validate cheaply first and escalate only while the idea still looks good.
  — [Itamar Gilad, "The Tool that Will Help You Choose Better Product Ideas"](https://itamargilad.com/the-tool-that-will-help-you-choose-better-product-ideas/); [Confidence Meter download page](https://itamargilad.com/resources/confidence-meter-calculator/)
- **Gilad on low-risk changes** (secondary): supporting data without a test is enough to launch only very small, low-risk, easily reverted changes. The four evidence bands are Opinions → Assessment → Data → Test results. — [Gilad search snippet / "How Much Product Discovery Is Enough?"](https://itamargilad.com/how-much-product-discovery/); summary in [Ziegelbecker, Medium](https://t-ziegelbecker.medium.com/a-summary-of-evidence-guided-by-itamar-gilad-part-2-ideas-and-steps-c1519f6de4a6)
- **Commitment as evidence**: time, reputation and money commitments are the real signals of interest; compliments and future promises are not. — [Khanna Law, Mom Test notes](https://www.khanna.law/notes/the-mom-test)
- **Amazon Working Backwards / PR-FAQ**:
  - Starts from five questions:
    1. Who is the customer?
    2. What is the customer's problem or opportunity?
    3. What is the most important customer benefit?
    4. How do you know what customers want or need?
    5. What does the customer experience look like?
  - A mock press release and FAQ are written before design or engineering starts.
  — [Working Backwards (Bryar & Carr) site](https://workingbackwards.com/concepts/working-backwards-pr-faq-process/); [Colin Bryar, "How to write an Amazon PR/FAQ"](https://docs.superhuman.com/@colin-bryar/working-backwards-how-write-an-amazon-pr-faq)
- **Decision records (ADR)**:
  - Sections: Title, Context (the forces at play, stated neutrally), Decision ("We will…"), Status (proposed/accepted/deprecated/superseded), Consequences (positive, negative, neutral).
  - Keep it 1–2 pages, in version control, numbered sequentially.
  - It only has value if kept up to date.
  — [Michael Nygard, Cognitect, Nov 15, 2011](https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- **Shreyas Doshi**:
  - Pre-mortems before launch, with people from every function, alternating quiet individual reflection and group discussion.
  - Many planning failures happen because information that would have changed the decision was available beforehand, but the culture didn't make room for it.
  — [Lenny's Podcast ep. 3, Shreyas Doshi](https://www.lennysnewsletter.com/p/episode-3-shreyas-doshi) (per search summary; transcript not fetched)

### Inferences
- **Proposed evidence-strength scale for Ruah** (synthesized from Gilad, Nielsen and Fitzpatrick; not an official standard):

| Level | Evidence type | Example | Default strength |
|---|---|---|---|
| 0 | Team opinion / "we assume" | "Users obviously want dark mode" | none |
| 1 | Trend / competitor has it / one stakeholder asked | "Linear has it" | very weak |
| 2 | Stated preference / hypothetical / survey intent | "I would use that" | weak |
| 3 | Specific past-behavior story (single interview) | "Last Tuesday I exported to CSV and…" | moderate |
| 4 | Repeated past-behavior pattern (3+ independent interviews) or support-ticket volume | 4 of 6 interviewees describe the same workaround | moderate-strong |
| 5 | Commitment (time/reputation/money) | pilot signed, intro given, pre-order | strong |
| 6 | Observed behavior / test result / analytics | prototype test, A/B, funnel data | strong |
| 7 | Launch data on the real metric | post-launch retention change | strongest |

- **Template for a good why**, drawn from job stories, PR-FAQ questions 1–4 and ADR context:
  `For [customer segment], when [situation], they struggle with [problem / job]. We know because [evidence ref(s), level N]. This step [does X] so they can [outcome]. We'll know it works when [signal: metric + threshold + timeframe]. Biggest open assumption: [question, assumption type].`
- **Examples of good vs bad whys** (illustrative, written for Ruah, not quoted):
  - Bad: "Users want an onboarding wizard." There is no customer, no evidence, no metric, and it is a solution rather than a problem.
  - Bad: "Because competitor X has it." This is thematic support only (level 1).
  - Bad: "Customer Acme asked for it." One request, and a feature request is bad data per the Mom Test.
  - Good: "Solo devs setting up their first project (situation) stall when asked to pick a model before seeing value. 3 of 5 interviewees in Sept 2026 described quitting at that screen (level 4). Deferring the choice lets them reach first agent run. Signal: % of new projects reaching first run within 10 minutes rises from X to Y. Open question (desirability): do power users feel slowed by the default?"

### Gaps
- I could not retrieve the exact numeric ranges Gilad assigns to each evidence type. They sit behind an email-gated download, and age-of-product.com returned 403. Only the ordering is sourced.
- I found no fetched primary source from Shreyas Doshi on a specific "product decision document" format. His pre-mortem guidance is sourced only via the podcast page summary.
- I found no reliable sources giving minimum sample sizes for qualitative discovery beyond Torres's "3–4 interviews before mapping" heuristic. Nielsen's widely cited "5 users" rule applies to usability testing, not discovery, and was not fetched here.
- Confirmation bias in discovery is implied by Torres ("bias and half-truths") and Nielsen (users say what designers want to hear), but I found no dedicated fetched source on it.

---

## (e) Capturing interview notes, turning them into evidence, and spotting say/do and design contradictions

### Takeaway
Keep raw notes: verbatim quotes, emotions, constraints and specific past events, with your own interpretation kept separate. Synthesize each interview into a snapshot within the hour. Break findings into atomic "nuggets" (observation + evidence + tags) so they can be searched and linked to decisions. Contradictions come from comparing what people say against what they do, and the design's assumptions against observed behavior.

### Cited Findings
- **Raw capture**:
  - Put quotes in quotation marks.
  - Log emotions and hard constraints.
  - Keep interpretation separate.
  - Clean up notes within about 5 minutes.
  - Review raw notes as a team, as a discussion rather than a presentation.
  — [Pakten, DEV, Mom Test Ch. 8 summary](https://dev.to/egepakten/what-i-learned-from-the-mom-test-chapter-8-running-the-process-242h)
- **Symbol tagging** for pain, goal, obstacle, workaround, context, feature request, money, person and follow-up. — [Waterstone Mom Test notes](https://waterstonefitness.notion.site/The-Mom-Test-Summary-And-Notes-946870b1df584bbf85f39a0138216721)
- **Per-interview synthesis**: the interview snapshot (quote, quick facts, opportunities, insights, experience map), done in 15–25 minutes after the interview. — [Torres, Product Talk, Feb 21, 2024](https://www.producttalk.org/interview-snapshot/)
- **Atomic research nuggets**:
  - Tomer Sharon's model: a nugget is a tagged observation backed by evidence (for example a 15–45 second video clip or a quote). Three parts: observation, evidence, tags.
  - Sharon built WeWork's Polaris repository on this model in 2017.
  — [User Interviews Field Guide, updated Nov 1, 2025](https://www.userinterviews.com/ux-research-field-guide-chapter/atomic-research-nuggets); [Tomer Sharon, "The atomic unit of a research insight," Medium](https://tsharon.medium.com/the-atomic-unit-of-a-research-insight-7bf13ec8fabe) (403 on fetch; content per search snippet)
- **Daniel Pidcock's variant**: experiments → facts → insights → recommendations/conclusions. Facts should carry no assumptions or opinion. — [User Interviews Field Guide](https://www.userinterviews.com/ux-research-field-guide-chapter/atomic-research-nuggets)
- **Tag dimensions to plan for**:
  - Procedural: date, source, method.
  - Demographic.
  - Experience: frequency, emotion.
  - Business: revenue band, product line.
  - Service design: journey phase, character.
  - Example nugget: "support articles are hard to find" + user quote + #Support #Navigation #Interviews.
  — [User Interviews Field Guide](https://www.userinterviews.com/ux-research-field-guide-chapter/atomic-research-nuggets)
- **Say/do gap**: stated preference correlates only moderately with measured performance (r ≈ 0.44–0.53). Self-reports suffer from people-pleasing, faulty memory and rationalization. — [Nielsen, NN/g, 2001](https://www.nngroup.com/articles/first-rule-of-usability-dont-listen-to-users/)
- **Feature requests vs behavior**: in the milkshake case, acting on stated requests (flavor, thickness) failed. Watching when and why shakes were bought revealed the real job. — [Re-Wired Group](https://therewiredgroup.com/case-studies/milkshakes/)
- **Guarding against over-indexing**: review the opportunity space every 3–4 weeks so the latest interview doesn't dominate. — [Torres, OST, Dec 6, 2023](https://www.producttalk.org/opportunity-solution-trees/)

### Inferences
- **Proposed machine-readable evidence record** for Ruah (a synthesis, not an external standard):
  ```yaml
  evidence:
    id: ev_2026_09_27_01
    quote: "..."                      # verbatim, in quotes
    speaker: {role: "solo dev", segment: "self-hosted", anonymized_id: "p07"}
    source: {type: interview|support_ticket|analytics|usability_test|survey|sales_call, ref: "path/or/url"}
    date: 2026-09-27
    kind: past_behavior|stated_preference|hypothetical|commitment|observed_behavior|metric
    strength_level: 0-7               # see scale in (d)
    tags: [pain|goal|obstacle|workaround|context|feature_request|money]
    emotion: excited|angry|embarrassed|neutral
    journey_step: onboarding.first_run
    supports|contradicts: [why_id]
  ```
- **Contradiction checks the agent could run**:
  1. Say vs do: a stated-preference quote ("I'd use templates") alongside analytics showing low template use.
  2. Design vs behavior: the step's `why` assumes a behavior (for example "users configure settings first"), but story evidence shows a workaround or a different order.
  3. Evidence vs evidence: two nuggets from different segments disagree. This suggests the step serves two jobs, as in the milkshake case.
  4. Why vs signal: the `why` claims outcome A, but the `signal` measures something unrelated (for example page views).
  5. Staleness: all evidence is older than N months, or predates a major design change.
- **Workflow sketch**:
  1. Prep the "big three" questions.
  2. Run a story-based interview.
  3. Take raw notes with symbols.
  4. Clean up within 5 minutes.
  5. Build a snapshot within the hour.
  6. Split into nuggets and tag them with journey steps.
  7. Link each nugget to a `why` as supporting or contradicting.
  8. Review every 3–4 interviews to update the opportunities and questions.

### Gaps
- I did not fetch Sharon's original Polaris article, so details such as the video-clip length (15–45 seconds) are secondhand via search snippets.
- I found no fetched source on affinity mapping specifically (for example an NN/g affinity-diagram article). It is a standard technique but not cited here.

---

## (f) Questions a product coach would ask when a design decision has no stated rationale, plus a draft question bank and red flags

### Takeaway
Coaching questions follow a few sourced patterns:
- Amazon's five PR-FAQ questions (who, what problem, what benefit, how do you know, what experience).
- Mom Test probes on feature requests (why do you want it, how do you cope today).
- The Four Forces.
- Torres's five assumption types.

Red flags are opinion-only evidence, single-customer requests, stated-preference-only evidence, and missing metrics.

### Cited Findings
- **The five questions** that anchor Working Backwards: who is the customer, what is the problem or opportunity, what is the most important benefit, how do you know, what is the experience. — [workingbackwards.com](https://workingbackwards.com/concepts/working-backwards-pr-faq-process/)
- **Feature-request probes**: "Why do you want that?", "How are you coping without it?", "What would that let you do?" — [Khanna Law, Mom Test notes](https://www.khanna.law/notes/the-mom-test)
- **Separate problem from solution**: an opportunity is a need that more than one solution could meet. — [Torres, OST](https://www.producttalk.org/opportunity-solution-trees/)
- **Opinion is near-zero confidence**, whether it comes from self, trends or colleagues. — [Gilad](https://itamargilad.com/the-tool-that-will-help-you-choose-better-product-ideas/)
- **Predictions of future behavior are the least trustworthy user data.** — [Nielsen, NN/g](https://www.nngroup.com/articles/first-rule-of-usability-dont-listen-to-users/)
- **Pre-mortem framing**: imagine the launch failed and ask why, involving every function. — [Lenny's Podcast, Doshi](https://www.lennysnewsletter.com/p/episode-3-shreyas-doshi)
- **Assumption categories** for open questions: desirability, viability, feasibility, usability, ethical. — [Torres on X](https://x.com/ttorres/status/1782787771188285800)

### Inferences
**Core coaching sequence for any step with an empty `why`.** This is a synthesis. The agent asks these and does not answer them.
1. Who exactly is on this step? (segment, situation, "when…")
2. What were they trying to get done right before this step, and right after?
3. What problem does this step solve for them, as opposed to for us?
4. How do we know? Can you point to a specific conversation, ticket or data point, with a date?
5. What were they doing before this existed? (the workaround)
6. What would we see if this step were working? (the signal)
7. What would convince us we're wrong? (falsifiable signal or a pre-mortem)
8. Which is riskiest: desirability, usability, feasibility, viability or ethics?
9. Is this a problem or a solution? Could another design meet the same need?

**Draft question bank by journey stage** (AARRR-style stages as requested; these questions are synthesized, not quoted):

- **Acquisition**
  - What situation makes someone go looking for a tool like this? What did they search for? (Moesta "What did you Google?")
  - Which push from their current setup brings them here? Which pull does this step promise?
  - Where did the last three real users come from? Do we have a dated source?
  - What does this step claim that a new visitor might doubt? (anxiety)
- **Onboarding / activation**
  - What is the first moment of value, and how many steps does it take to get there today?
  - What must the user stop doing, or give up, to adopt this? (habit)
  - What anxiety might stop them at this step, such as data access, cost or lock-in? Do we have a quote showing it?
  - Tell me about the last user who got stuck here. What did they do instead?
  - Signal check: what share reach the activation event, and within what time?
- **Core action**
  - What job does the core action do? Write it as "When…, I want to…, so I can…"
  - What workaround did users rely on before this? Is it still in use alongside?
  - Is the evidence for this design stated preference or observed behavior?
  - Would the user choose this over their old way if we removed it? How do we know?
- **Retention**
  - What brings someone back in the second week? Name a specific user and date.
  - What competes for the same job between sessions (the "bananas and doughnuts")?
  - What is the leading indicator that someone is about to churn from this step?
- **Referral**
  - Has anyone actually introduced us to someone else? (reputation commitment)
  - What would a user have to experience at this step to risk their reputation recommending it?
  - Do we have referral data, or only "I'd recommend it" statements?
- **Revenue**
  - Where does the money come from, and who signs off? (Mom Test B2B question)
  - What have users already paid for to solve this, including time, tools or contractors?
  - Any commitment signal: pilot, LOI, pre-order, paid upgrade?
  - What viability assumption would break the business case for this step?

**Red flags the agent should raise** (synthesized rules; each maps to a sourced principle):

| Red flag | Detection heuristic | Why it's a flag |
|---|---|---|
| "We assume users want…" / "obviously" / "everyone needs" | opinion language, no evidence ref | Opinion = near-zero confidence (Gilad) |
| Feature requested by one customer | evidence count = 1, kind = feature_request | Feature requests are bad data; dig into motive (Fitzpatrick) |
| No signal/metric | `signal` empty or vanity metric | The why can't be falsified or shown to work |
| Only stated-preference evidence | all evidence kind ∈ {stated_preference, hypothetical, survey intent} | Stated preference ≠ behavior (Nielsen) |
| Compliments as evidence | quotes like "love it", "great idea" | Compliments signal pitching, not learning (Fitzpatrick) |
| Future or conditional verbs in quotes | "would", "will", "might" | Fluff: predictions are unreliable (Nielsen, Fitzpatrick) |
| Why names a solution, not a problem | why text describes a UI or feature | Opportunity ≠ solution (Torres) |
| "Competitor has it" | thematic or competitive justification only | Thematic support is weak (Gilad) |
| Stale or undated evidence | no date, or older than the last major redesign | Can't judge relevance |
| Single segment presented as everyone | all evidence from one persona or account | Risk of over-indexing (Torres 3–4 week review) |
| Contradicting evidence ignored | nuggets tagged `contradicts` with no response | Confirmation bias |
| Signal doesn't measure the why's outcome | mismatch between the outcome clause and the metric | Rationale and metric are disconnected |

**Agent behavior rules for Ruah** (design recommendation, inferred):
- Never generate the `why` text. Offer the coaching questions and a template, and fill fields only from user-supplied answers or attached evidence.
- Every `evidence` item needs a verbatim quote (or a data reference), a source and a date. Otherwise it stays in `question`, not `evidence`.
- Show evidence strength next to the `why`. Open a `question` automatically when the strength is ≤ 2.

### Gaps
- No source I found publishes a canonical coaching question bank for journey stages. The stage-grouped bank above is my synthesis from the cited frameworks and should be treated as a draft.
- Shreyas Doshi's written guidance on product decision rationale (beyond pre-mortems and LNO) was not retrieved.
