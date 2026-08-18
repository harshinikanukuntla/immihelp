/**
 * ATS-style keyword analysis.
 *
 * ## What an ATS actually does
 *
 * An Applicant Tracking System is the software an employer uses to store and
 * filter applications. When people say "ATS score" they mean something
 * mechanical: the posting names some skills, the system checks which appear in
 * your resume, and ranks you by how many matched. It is closer to Ctrl-F than to
 * understanding.
 *
 * That mechanical quality is why it is the headline number here rather than the
 * semantic similarity score:
 *
 * - **It is deterministic.** The same resume and posting always give the same
 *   number. A fit score that changes when you refresh is worse than no score,
 *   because it teaches you not to trust anything else in the panel either.
 * - **It is explainable.** "18 of 25 terms" means something. A cosine similarity
 *   of 0.61 does not.
 * - **The advice is arithmetic.** "Adding Kubernetes takes you 72% -> 78%" is
 *   that term's weight moving between numerator and denominator, not a guess.
 *
 * ## Terms must look like skills, not merely be frequent
 *
 * The first version ranked any repeated word and produced garbage: `re` and `ll`
 * (fragments of "we're" and "you'll"), and `small`, which a posting can repeat a
 * dozen times without it ever being a requirement.
 *
 * Frequency is not evidence. A term now enters the vocabulary only if something
 * about the posting marks it as a *requirement*:
 *
 *   1. it is a known skill (`SKILL_LEXICON`), or
 *   2. it appears inside a requirement frame — "experience with X",
 *      "proficiency in X", "3+ years of X", or
 *   3. it is a multi-word phrase inside a requirements bullet.
 *
 * Repetition still raises a qualifying term's weight; it can no longer admit one.
 * That is what keeps "pricing" for a product role (it appears in a requirements
 * bullet) while dropping "small" (it never does).
 *
 * The lexicon is necessarily incomplete and always will be — it is the part of
 * this file that most wants replacing with a model that can read a requirement
 * it has never seen. See `docs/` for that discussion.
 */

/** Grammatical filler. Never a requirement in any field. */
const STOPWORDS = new Set(
  (
    'a an the and or but if then than that this these those with without within for from to of in ' +
    'on at by as is are was were be been being have has had do does did will would can could should ' +
    'may might must you your our we us they their it its not no yes about into over under more most ' +
    'other some such only own same so too very just also across per via using use used work working ' +
    'works role roles team teams company companies year years experience experienced ability able ' +
    'help helps helping including include includes new looking join joining candidate candidates ' +
    'applicant applicants position positions job jobs opportunity opportunities responsibilities ' +
    'requirements qualifications preferred required plus benefits salary apply who what when where ' +
    'how why all any each both few many much need needs well like day days week weeks month months ' +
    'time times end ensure ensuring while during between through here there make makes making take ' +
    'takes look looks based upon etc eg ie inc llc ltd corp you.ll we.re'
  ).split(' '),
);

/**
 * Adjectives and vague nouns that describe a requirement without being one.
 *
 * "Small" is the case that exposed this: a posting about small businesses says
 * it constantly, and it is never something you could add to a resume. These are
 * blocked outright, even inside a requirements bullet.
 */
const NEVER_SKILLS = new Set(
  (
    'small large big high low fast quick slow strong excellent great good best better top solid ' +
    'proven deep broad wide clear simple complex hard easy early late long short full part senior ' +
    'junior lead principal staff mid level entry global local remote hybrid onsite flexible ' +
    'competitive comprehensive robust scalable reliable efficient effective successful passionate ' +
    'motivated driven curious collaborative dynamic innovative exciting meaningful impactful ' +
    'various several multiple different similar related relevant appropriate significant critical ' +
    'key core main primary overall general specific detailed thorough careful thoughtful ' +
    'first second third next last previous current recent future past today tomorrow ' +
    'people person team member members colleague colleagues customer customers client clients ' +
    'user users business businesses organization organizations industry industries market markets ' +
    'world class real true right wrong sure able unable willing ready happy excited ' +
    'plus bonus nice must should would could may might will shall'
  ).split(' '),
);

/**
 * Fragments left by contractions.
 *
 * The tokenizer now strips contraction tails, but these stay blocked as a second
 * line of defence — they were the most visibly broken output the tool produced.
 */
const FRAGMENTS = new Set(['re', 'll', 've', 's', 't', 'd', 'm', 'n', 'st', 'nd', 'rd', 'th', 'don']);

/**
 * Known skills, tools, and methods.
 *
 * Deliberately spans engineering, data, product, and design, because the
 * extension runs on whatever posting the user is looking at. Incomplete by
 * nature; adding entries is the cheapest possible contribution to this project.
 */
const SKILL_LEXICON = new Set([
  // Languages
  'python', 'java', 'javascript', 'typescript', 'go', 'golang', 'rust', 'c++', 'c#', 'ruby', 'php',
  'scala', 'kotlin', 'swift', 'objective-c', 'perl', 'r', 'matlab', 'sql', 'bash', 'shell', 'html',
  'css', 'sass', 'elixir', 'haskell', 'clojure', 'dart', 'lua',
  // Frameworks and runtimes
  'react', 'angular', 'vue', 'svelte', 'next.js', 'nuxt', 'node.js', 'nodejs', 'deno', 'django',
  'flask', 'fastapi', 'spring', 'rails', '.net', 'express', 'laravel', 'symfony', 'jquery',
  'react native', 'flutter', 'electron', 'tailwind', 'bootstrap',
  // Data
  'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'cassandra', 'dynamodb', 'sqlite',
  'kafka', 'rabbitmq', 'spark', 'hadoop', 'flink', 'snowflake', 'databricks', 'airflow', 'dbt',
  'elasticsearch', 'bigquery', 'redshift', 'clickhouse', 'etl', 'elt', 'data warehouse',
  'data pipeline', 'data modeling', 'data modelling',
  // Cloud and infrastructure
  'aws', 'azure', 'gcp', 'google cloud', 'kubernetes', 'k8s', 'docker', 'terraform', 'ansible',
  'pulumi', 'jenkins', 'circleci', 'github actions', 'gitlab', 'helm', 'istio', 'nginx',
  'prometheus', 'grafana', 'datadog', 'splunk', 'pagerduty', 'lambda', 'serverless', 'ec2', 's3',
  'ci/cd', 'infrastructure as code', 'linux', 'unix', 'git',
  // Machine learning
  'machine learning', 'deep learning', 'nlp', 'computer vision', 'pytorch', 'tensorflow', 'keras',
  'scikit-learn', 'sklearn', 'pandas', 'numpy', 'llm', 'llms', 'transformers', 'hugging face',
  'reinforcement learning', 'mlops', 'feature engineering', 'model training',
  // Architecture and practice
  'microservices', 'rest', 'restful', 'graphql', 'grpc', 'api', 'apis', 'websockets', 'oauth',
  'saml', 'sso', 'jwt', 'agile', 'scrum', 'kanban', 'tdd', 'bdd', 'devops', 'sre', 'system design',
  'distributed systems', 'observability', 'monitoring', 'load balancing', 'caching', 'sharding',
  'event driven', 'message queue', 'unit testing', 'integration testing', 'code review',
  'design patterns', 'object oriented', 'functional programming', 'concurrency', 'multithreading',
  'performance tuning', 'security', 'encryption', 'penetration testing', 'threat modeling',
  // Product and analytics
  'roadmap', 'roadmapping', 'product strategy', 'go-to-market', 'gtm', 'user research',
  'a/b testing', 'ab testing', 'experimentation', 'analytics', 'tableau', 'looker', 'amplitude',
  'mixpanel', 'segment', 'kpi', 'kpis', 'okr', 'okrs', 'forecasting', 'segmentation', 'pricing',
  'monetization', 'marketplace', 'stakeholder management', 'prioritization', 'discovery',
  'customer discovery', 'competitive analysis', 'market research', 'business intelligence',
  'sql queries', 'dashboards', 'metrics', 'funnel', 'retention', 'churn', 'cohort analysis',
  // Design
  'figma', 'sketch', 'adobe xd', 'wireframing', 'prototyping', 'usability testing',
  'design systems', 'accessibility', 'wcag', 'interaction design', 'visual design',
  // Tools
  'jira', 'confluence', 'notion', 'asana', 'linear', 'slack', 'salesforce', 'hubspot', 'zendesk',
  'excel', 'powerpoint', 'google analytics',
]);

/**
 * Frames that introduce a requirement.
 *
 * Whatever follows these phrases is what the employer is asking for, regardless
 * of whether our lexicon happens to know the term. This is what lets the
 * analysis work on postings in fields the lexicon does not cover.
 */
const SKILL_FRAMES: RegExp[] = [
  /\b(?:experience|expertise|proficiency|proficient|background|fluency|fluent|familiarity|familiar|skilled|competency|competence)\s+(?:with|in|of|using)\s+([^.;:\n]{2,80})/gi,
  /\b(?:knowledge|understanding|command|mastery)\s+of\s+([^.;:\n]{2,80})/gi,
  /\b\d+\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:experience\s+)?(?:with|in|building|working\s+(?:with|on))?\s*([^.;:\n]{2,80})/gi,
  /\b(?:strong|deep|hands-on|working)\s+(?:knowledge|experience|background)\s+(?:with|in|of)\s+([^.;:\n]{2,80})/gi,
  /\b(?:ability|able)\s+to\s+([^.;:\n]{2,80})/gi,
];

/** Headings that mark the start of the requirements. */
const REQUIREMENT_HEADINGS =
  /\b(requirements?|qualifications?|what you.{0,3}ll (?:need|bring|do)|who you are|must have|we.{0,3}re looking for|skills?|about you|basic qualifications?|minimum qualifications?|nice to have|preferred)\b/i;

/** A bullet line — the shape requirements are almost always written in. */
const BULLET_LINE = /^\s*(?:[-–—*•‣▪]|\d+[.)])\s+/;

const REQUIREMENT_MULTIPLIER = 2;
const MAX_OCCURRENCE_WEIGHT = 3;

/** Base weight by how strong the evidence of skill-ness is. */
const EVIDENCE_WEIGHT = {
  lexicon: 3,
  frame: 2,
  bullet_phrase: 2,
} as const;

type Evidence = keyof typeof EVIDENCE_WEIGHT;

/** Contraction tails, stripped so "we're" does not become "we" + "re". */
const CONTRACTION_TAIL = /n?['’](?:s|re|ll|ve|d|t|m)$/;

const MIN_TERM_LENGTH = 2;

export interface KeywordGap {
  term: string;
  weight: number;
  occurrences: number;
  inRequirements: boolean;
  /** Why this term counted as a requirement at all. */
  evidence: Evidence;
}

export interface Suggestion {
  term: string;
  projectedScore: number;
  gain: number;
  inRequirements: boolean;
}

export interface AtsAnalysis {
  score: number;
  band: 'strong' | 'moderate' | 'weak';
  matched: string[];
  missing: KeywordGap[];
  suggestions: Suggestion[];
  totalTerms: number;
  matchedTerms: number;
  totalWeight: number;
  matchedWeight: number;
  summary: string;
}

/**
 * Splits text into comparable terms.
 *
 * Keeps punctuation that lives inside technology names, so "node.js", "c++",
 * "ci/cd", and "h-1b" survive intact. Strips contraction tails, which previously
 * produced the terms `re` and `ll` and made the whole feature look broken.
 */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z][a-z0-9+#./'’-]*[a-z0-9+#]|[a-z]+/g) ?? [];

  return matches
    .map((term) => term.replace(CONTRACTION_TAIL, '').replace(/^[.\-/'’]+|[.\-/'’]+$/g, ''))
    .filter((term) => term.length >= MIN_TERM_LENGTH && !FRAGMENTS.has(term));
}

/** True if a token could ever be part of a requirement. */
function isCandidateWord(word: string): boolean {
  return !STOPWORDS.has(word) && !NEVER_SKILLS.has(word) && !FRAGMENTS.has(word);
}

/** Unigrams and bigrams built only from words that could be requirements. */
function phrasesFrom(tokens: string[]): string[] {
  const phrases: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]!;
    if (!isCandidateWord(word)) continue;

    phrases.push(word);

    const next = tokens[i + 1];
    if (next && isCandidateWord(next)) phrases.push(`${word} ${next}`);
  }

  return phrases;
}

/** Longest lexicon entries first, so "machine learning" wins over "learning". */
const LEXICON_PHRASES = [...SKILL_LEXICON].sort((a, b) => b.length - a.length);

/** Lexicon hits in a line, matched on whole words. */
function lexiconHits(line: string): string[] {
  const lower = line.toLowerCase();
  const hits: string[] = [];

  for (const skill of LEXICON_PHRASES) {
    // Word-boundary check that tolerates the punctuation inside tech names.
    const index = lower.indexOf(skill);
    if (index === -1) continue;

    const before = index === 0 ? ' ' : lower[index - 1]!;
    const after = index + skill.length >= lower.length ? ' ' : lower[index + skill.length]!;
    if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;

    hits.push(skill);
  }

  return hits;
}

interface Draft {
  term: string;
  occurrences: number;
  inRequirements: boolean;
  evidence: Evidence;
}

/**
 * Builds the vocabulary of things the posting is actually asking for.
 *
 * Every term arrives with a reason. Nothing is admitted for being frequent.
 */
function extractRequirements(jobDescription: string): Map<string, Draft> {
  const drafts = new Map<string, Draft>();

  const add = (term: string, evidence: Evidence, inRequirements: boolean) => {
    if (term.length < MIN_TERM_LENGTH) return;
    if (term.split(' ').some((word) => !isCandidateWord(word))) return;

    const existing = drafts.get(term);
    if (existing) {
      existing.occurrences += 1;
      existing.inRequirements ||= inRequirements;
      // Keep the strongest evidence seen for this term.
      if (EVIDENCE_WEIGHT[evidence] > EVIDENCE_WEIGHT[existing.evidence]) {
        existing.evidence = evidence;
      }
      return;
    }
    drafts.set(term, { term, occurrences: 1, inRequirements, evidence });
  };

  let inRequirements = false;

  for (const line of jobDescription.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (REQUIREMENT_HEADINGS.test(trimmed)) inRequirements = true;
    else if (!BULLET_LINE.test(trimmed) && /^[A-Z][^.!?]{0,60}:?$/.test(trimmed)) {
      // A short title-case line that is not a bullet starts a new section.
      inRequirements = false;
    }

    // 1. Known skills, wherever they appear.
    for (const skill of lexiconHits(trimmed)) add(skill, 'lexicon', inRequirements);

    // 2. Whatever follows a requirement frame.
    for (const frame of SKILL_FRAMES) {
      frame.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = frame.exec(trimmed)) !== null) {
        for (const phrase of phrasesFrom(tokenize(match[1] ?? ''))) {
          add(phrase, 'frame', inRequirements);
        }
      }
    }

    // 3. Multi-word phrases inside a requirements bullet. Restricted to phrases
    //    because single words in a bullet are too often prose ("small", "team").
    if (BULLET_LINE.test(trimmed) && inRequirements) {
      for (const phrase of phrasesFrom(tokenize(trimmed))) {
        if (phrase.includes(' ')) add(phrase, 'bullet_phrase', inRequirements);
      }
    }
  }

  return drafts;
}

/** Turns drafts into weighted, ranked terms. */
function weighTerms(drafts: Map<string, Draft>): KeywordGap[] {
  const terms = [...drafts.values()].map((draft) => ({
    term: draft.term,
    occurrences: draft.occurrences,
    inRequirements: draft.inRequirements,
    evidence: draft.evidence,
    weight:
      EVIDENCE_WEIGHT[draft.evidence] *
      Math.min(draft.occurrences, MAX_OCCURRENCE_WEIGHT) *
      (draft.inRequirements ? REQUIREMENT_MULTIPLIER : 1),
  }));

  return terms
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    // A posting screens on a few dozen things. Capping keeps the denominator
    // stable and the missing list actionable.
    .slice(0, 30);
}

/** The resume, prepared once so every lookup is a set membership test. */
interface ResumeIndex {
  tokens: Set<string>;
  bigrams: Set<string>;
  raw: string;
}

function indexResume(resumeText: string): ResumeIndex {
  const tokens = tokenize(resumeText);
  const bigrams = new Set<string>();

  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.add(`${tokens[i]} ${tokens[i + 1]}`);
  }

  return { tokens: new Set(tokens), bigrams, raw: resumeText.toLowerCase() };
}

/**
 * True if the resume covers a term.
 *
 * Phrases are checked against the resume's own bigrams *and* its raw text, since
 * both sides drop filler when forming phrases. Single words use exact token
 * matching, never substrings — otherwise "javascript" would satisfy a
 * requirement for "java", the classic keyword-matching false positive.
 */
function resumeCovers(term: string, resume: ResumeIndex): boolean {
  if (term.includes(' ')) return resume.bigrams.has(term) || resume.raw.includes(term);
  return resume.tokens.has(term);
}

export function analyzeAts(resumeText: string, jobDescription: string): AtsAnalysis {
  const terms = weighTerms(extractRequirements(jobDescription));
  const resume = indexResume(resumeText);

  const matched: KeywordGap[] = [];
  const missing: KeywordGap[] = [];

  for (const entry of terms) {
    if (resumeCovers(entry.term, resume)) matched.push(entry);
    else missing.push(entry);
  }

  const totalWeight = terms.reduce((sum, entry) => sum + entry.weight, 0);
  const matchedWeight = matched.reduce((sum, entry) => sum + entry.weight, 0);
  const score = totalWeight === 0 ? 0 : Math.round((matchedWeight / totalWeight) * 100);

  // Each projection is the real arithmetic: that term's weight moving from the
  // missing pile to the matched pile. Nothing here is estimated.
  const suggestions: Suggestion[] = missing.slice(0, 5).map((entry) => {
    const projected =
      totalWeight === 0 ? 0 : Math.round(((matchedWeight + entry.weight) / totalWeight) * 100);
    return {
      term: entry.term,
      projectedScore: projected,
      gain: projected - score,
      inRequirements: entry.inRequirements,
    };
  });

  return {
    score,
    band: score >= 70 ? 'strong' : score >= 45 ? 'moderate' : 'weak',
    matched: matched.map((entry) => entry.term),
    missing,
    suggestions,
    totalTerms: terms.length,
    matchedTerms: matched.length,
    totalWeight,
    matchedWeight,
    summary: buildSummary(score, matched.length, terms.length, suggestions),
  };
}

function buildSummary(
  score: number,
  matchedCount: number,
  totalCount: number,
  suggestions: Suggestion[],
): string {
  if (totalCount < 5) {
    // Too few recognisable requirements to divide by. Saying so is better than
    // reporting a percentage derived from three terms.
    return 'This posting does not name enough specific skills to score reliably.';
  }

  const parts = [
    `Your resume covers ${matchedCount} of the ${totalCount} skills this posting asks for (${score}%).`,
  ];

  if (suggestions.length > 0) {
    const best = suggestions[0]!;
    parts.push(`Adding “${best.term}” alone would take it to ${best.projectedScore}%.`);
  }

  parts.push('This models common keyword screening, not any specific employer’s system.');
  return parts.join(' ');
}

/**
 * Score if every suggested term were added at once.
 *
 * Not the sum of the individual gains: all five share one denominator, so adding
 * five terms is a single larger numerator, not five independent jumps.
 */
export function projectedScoreWithAll(analysis: AtsAnalysis): number {
  if (analysis.totalWeight === 0) return analysis.score;

  const suggestedWeight = analysis.suggestions.reduce((sum, suggestion) => {
    const gap = analysis.missing.find((entry) => entry.term === suggestion.term);
    return sum + (gap?.weight ?? 0);
  }, 0);

  return Math.round(((analysis.matchedWeight + suggestedWeight) / analysis.totalWeight) * 100);
}
