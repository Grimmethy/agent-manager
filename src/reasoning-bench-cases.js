'use strict';

// Fixed battery of reasoning probes for reasoning-bench.js. Every prompt ends with an
// explicit "end your reply with a line of the exact form: FINAL ANSWER: <answer>"
// instruction so grading can extract one answer line via regex regardless of how much
// chain-of-thought the model produces around it -- this is a reasoning benchmark, not an
// instruction-following one, so the harness has to be tolerant of the model rambling
// first and only strict about the one line it actually scores.
//
// grader:
//   'exact'  -- case-insensitive, trimmed string equality against `expected`.
//   'numeric' -- parses the answer as a number, compares to `expected` within `tolerance`
//                (default 0).
//   'regex'  -- `expected` is a RegExp source string, tested against the answer.
//   'judge'  -- no objectively-checkable answer; expected` is the rubric text a Claude
//               judge call scores the FULL response against (not just the final-answer
//               line -- these probe the reasoning itself, not a single fact).
//
// Categories deliberately span failure modes that differ from each other, not just
// difficulty -- a model can be strong on one and weak on another, and averaging across
// only one category would hide that.
const CASES = [
  {
    id: 'logic-01-misdirection',
    category: 'misdirection',
    description: 'The classic "bat and ball" cognitive-reflection problem. Most people\'s '
      + 'first instinct is the wrong intuitive answer (10 cents, from subtracting instead '
      + 'of solving the algebra). Measures whether the model actually sets up and solves '
      + 'the two equations instead of pattern-matching to that instinct.',
    // Classic "surface pattern-match trap" -- a naive model pattern-matches to the famous
    // bat-and-ball problem's WRONG intuitive answer ($0.10) instead of actually solving
    // this one, which isn't that problem.
    prompt: 'A bat and a ball together cost $1.10. The bat costs exactly $1.00 more than '
      + 'the ball. How much does the ball cost, in dollars? Show your work, then end your '
      + 'reply with a line of the exact form: FINAL ANSWER: <number>',
    grader: 'numeric',
    expected: 0.05,
    tolerance: 0.001,
  },
  {
    id: 'logic-02-misdirection-variant',
    category: 'misdirection',
    description: 'Same problem shape as logic-01-misdirection but with different numbers. '
      + 'A model that merely memorized "the bat-and-ball answer is 5 cents" as a fact '
      + 'rather than learning the underlying method would fail here -- this checks for '
      + 'genuine generalization, not memorized recall of the famous version.',
    // Same surface shape, DIFFERENT numbers than the famous version -- catches a model
    // that memorized "the answer is 5 cents" as a fact rather than the method.
    prompt: 'A pen and a notebook together cost $3.20. The notebook costs exactly $2.00 '
      + 'more than the pen. How much does the pen cost, in dollars? Show your work, then '
      + 'end your reply with a line of the exact form: FINAL ANSWER: <number>',
    grader: 'numeric',
    expected: 0.6,
    tolerance: 0.001,
  },
  {
    id: 'logic-03-grid-puzzle',
    category: 'constraint-satisfaction',
    description: 'A small logic-grid puzzle: three people, three floors, three pets, four '
      + 'clues. Measures whether the model can track several interacting constraints at '
      + 'once and derive the one answer consistent with ALL of them, rather than '
      + 'satisfying just the first clue or two it happens to apply.',
    prompt: 'Three friends -- Ada, Bo, and Cy -- each own exactly one of a cat, a dog, or '
      + 'a bird, and each lives on a different one of floors 1, 2, or 3 of the same '
      + 'building. Clues: (1) Ada does not live on floor 1. (2) The dog owner lives on '
      + 'floor 1. (3) Bo owns the bird. (4) Cy lives on floor 2. Who owns the dog? '
      + 'Reason through the clues, then end your reply with a line of the exact form: '
      + 'FINAL ANSWER: <name>',
    grader: 'exact',
    expected: 'ada',
  },
  {
    id: 'logic-04-multihop',
    category: 'multi-hop',
    description: 'A syllogism chained across three nonsense-word premises (glorbs -> '
      + 'wibbly -> flenk -> not red). The nonsense words are deliberate: the model can\'t '
      + 'fall back on real-world knowledge about the objects, so it has to follow the '
      + 'chain of premises purely structurally to reach the conclusion.',
    prompt: 'All glorbs are wibbly. Every wibbly thing is also flenk. No flenk thing is '
      + 'red. Is a glorb ever red? Reason through the chain, then end your reply with a '
      + 'line of the exact form: FINAL ANSWER: <yes or no>',
    grader: 'exact',
    expected: 'no',
  },
  {
    id: 'code-01-trace',
    category: 'code-tracing',
    description: 'Hand-execute a small loop with reverse iteration, a `continue`, and '
      + 'index-dependent arithmetic. Measures precise step-by-step state tracking rather '
      + 'than an approximate "looks about right" answer -- skipping one iteration or one '
      + 'off-by-one error produces a different final number, so there is no partial credit '
      + 'for "close."',
    prompt: 'Trace this JavaScript by hand, step by step, then give the value logged:\n'
      + '```js\n'
      + 'let arr = [1, 2, 3, 4, 5];\n'
      + 'let total = 0;\n'
      + 'for (let i = arr.length - 1; i >= 0; i--) {\n'
      + '  if (arr[i] % 2 === 0) continue;\n'
      + '  total += arr[i] * (i + 1);\n'
      + '}\n'
      + 'console.log(total);\n'
      + '```\n'
      + 'End your reply with a line of the exact form: FINAL ANSWER: <number>',
    grader: 'numeric',
    // i=4 (5, odd): 5*5=25; i=3 (4, even): skip; i=2 (3, odd): 3*3=9; i=1 (2, even): skip;
    // i=0 (1, odd): 1*1=1 -> 25+9+1=35
    expected: 35,
    tolerance: 0,
  },
  {
    id: 'code-02-bug-hunt',
    category: 'code-tracing',
    description: 'Find a subtle bug in a "second-largest distinct value" function that '
      + 'actually mishandles duplicate values. Measures whether the model can trace a '
      + 'specific edge-case input through the code\'s actual logic, rather than judging '
      + 'the code "looks correct" from its overall shape.',
    prompt: 'This function is supposed to return the SECOND-largest distinct number in an '
      + 'array, but it has a bug. Identify the bug and state the ONE-WORD variable name '
      + 'that is used incorrectly:\n'
      + '```js\n'
      + 'function secondLargest(nums) {\n'
      + '  let first = -Infinity, second = -Infinity;\n'
      + '  for (const n of nums) {\n'
      + '    if (n > first) {\n'
      + '      second = first;\n'
      + '      first = n;\n'
      + '    } else if (n > second) {\n'
      + '      second = n;\n'
      + '    }\n'
      + '  }\n'
      + '  return second;\n'
      + '}\n'
      + '```\n'
      + 'Hint: consider the input [5, 5, 3]. Explain the failure, then end your reply with '
      + 'a line of the exact form: FINAL ANSWER: <variable name>',
    grader: 'exact',
    // Duplicate values aren't excluded -- when n === first (5 == first 5), the first
    // branch's `n > first` is false and the elif `n > second` (5 > -Infinity) is true, so
    // `second` gets set to the DUPLICATE first value (5) instead of staying distinct.
    expected: 'second',
  },
  {
    id: 'plan-01-ordering',
    category: 'planning',
    description: 'A dependency-ordering (topological sort) task: five tasks, several with '
      + 'prerequisites on more than one other task. Measures whether the model can produce '
      + 'a valid execution order that satisfies every prerequisite constraint at once -- '
      + 'several valid orders exist, so any one that respects all constraints counts.',
    prompt: 'Five tasks, each with prerequisites: '
      + 'A has no prerequisites. '
      + 'B requires A. '
      + 'C requires A. '
      + 'D requires B and C. '
      + 'E requires C. '
      + 'List one valid order to complete all five tasks such that every prerequisite is '
      + 'done before the task that needs it. There may be more than one valid order -- '
      + 'give just one. End your reply with a line of the exact form: '
      + 'FINAL ANSWER: <comma-separated letters, e.g. A,B,C,D,E>',
    grader: 'regex',
    // Any topological order where A precedes B,C,D,E; B&C precede D; C precedes E.
    expected: '^A,(B,C,D,E|B,C,E,D|C,B,D,E|C,B,E,D|C,E,B,D)$',
  },
  {
    id: 'math-01-combinatorics',
    category: 'quantitative',
    description: 'A conditional-probability combinatorics problem: the chance a 3-person '
      + 'committee drawn from 4 women and 3 men has at least 2 women. Measures multi-step '
      + 'quantitative reasoning -- enumerating the qualifying cases, computing each '
      + 'combination count, and summing them correctly rather than a single-step guess.',
    prompt: 'A committee of 3 people is chosen from a group of 4 women and 3 men. What is '
      + 'the probability that the committee has at least 2 women? Give the answer as a '
      + 'reduced fraction. Show your work, then end your reply with a line of the exact '
      + 'form: FINAL ANSWER: <fraction, e.g. 1/2>',
    grader: 'exact',
    // C(7,3)=35 total. At least 2 women: C(4,2)*C(3,1) + C(4,3)*C(3,0) = 6*3 + 4*1 = 22.
    // 22/35 (already reduced, gcd(22,35)=1).
    expected: '22/35',
  },
  {
    id: 'counterfactual-01',
    category: 'causal-reasoning',
    description: 'An open-ended causal-reasoning scenario (an incident postmortem) with no '
      + 'single correct number -- a Claude call judges the response against a written '
      + 'rubric instead. Measures whether the model distinguishes "responded sooner" from '
      + '"resolved sooner" and acknowledges real uncertainty, rather than asserting a '
      + 'confident but unsupported causal claim.',
    grader: 'judge',
    prompt: 'A server outage happened at 2:00am. The on-call engineer was paged at 2:03am '
      + 'but did not respond until 2:45am because their phone was on silent overnight. By '
      + 'the time they started investigating, a second, unrelated database failure had '
      + 'also occurred at 2:20am, which they discovered and fixed first because its '
      + 'alert was clearer. The original server outage was not resolved until 4:10am. '
      + 'Question: if the engineer HAD responded immediately at 2:03am, is it certain '
      + 'the original outage would have been resolved before 4:10am? Explain your '
      + 'reasoning about what is and is not actually certain here, in 3-6 sentences.',
    expected: 'A strong answer says NO, it is not certain -- explicitly distinguishes '
      + '"responded sooner" from "resolved sooner," and notes real uncertainty: the '
      + 'second failure still would have needed handling at some point, the original '
      + 'outage\'s actual root-cause difficulty is unknown, and 3+ hours of unexplained '
      + 'silence between 2:03 and 4:10 suggests the delay likely was NOT solely the late '
      + 'start. A weak answer just asserts "yes, responding sooner means it would have '
      + 'been fixed sooner" without acknowledging the missing information, or ignores the '
      + 'second incident entirely.',
  },
  {
    id: 'self-consistency-01',
    category: 'self-consistency',
    description: 'Asks the model to evaluate an argument that conflates LOGICAL VALIDITY '
      + '(does the conclusion follow from the premises) with FACTUAL TRUTH (is the '
      + 'conclusion true in reality) -- the classic invalid-premise-but-valid-form penguin '
      + 'syllogism. Measures whether the model can correctly separate those two questions '
      + 'instead of collapsing them, a conflation even capable reasoners often make.',
    grader: 'judge',
    prompt: 'Is the following argument logically valid? "All birds can fly. Penguins are '
      + 'birds. Therefore, penguins can fly. We know this conclusion is false in reality, '
      + 'which proves the argument itself is invalid." Explain clearly whether the '
      + 'ARGUMENT\'s logical validity (a property of its structure) is the same question '
      + 'as whether its conclusion is factually TRUE (a property of the world), and give '
      + 'your verdict.',
    expected: 'A strong answer separates validity from soundness: the argument IS '
      + 'logically valid (the conclusion follows necessarily from the premises via '
      + 'correct syllogistic form) even though it is NOT sound (the first premise "all '
      + 'birds can fly" is factually false). It explicitly rejects the prompt\'s claim '
      + 'that "conclusion is false in reality" proves the argument invalid -- that '
      + 'conflates validity with soundness/truth. A weak answer agrees the argument is '
      + '"invalid" because the conclusion is false, or is internally inconsistent (calls '
      + 'it both valid and invalid without resolving the distinction).',
  },
  {
    id: 'ambiguity-01',
    category: 'requirement-reasoning',
    description: 'A deliberately underspecified engineering request ("make the button '
      + 'bigger") that could refer to any of three different real buttons. Measures '
      + 'whether the model recognizes the real ambiguity and makes a concrete, reasoned '
      + 'decision about how to proceed, rather than silently guessing or giving generic '
      + '"communication is important" filler with no actual decision.',
    grader: 'judge',
    prompt: 'A user asks: "Make the button bigger." The button in question appears in '
      + 'three different places in the app: a mobile nav bar, a desktop settings page, '
      + 'and an email template. List the ambiguities a careful engineer should actually '
      + 'resolve before writing code, and state what you would do RIGHT NOW given only '
      + 'this one sentence of instruction -- proceed with an assumption, or ask a '
      + 'clarifying question first, and why.',
    expected: 'A strong answer identifies the real ambiguity (WHICH button/place, and '
      + 'possibly by how much / to what size) and gives a reasoned, non-generic '
      + 'recommendation for what to actually do given only one sentence -- e.g. ask '
      + 'which instance, or make a stated, reversible assumption and flag it -- rather '
      + 'than a generic "always ask for clarification" non-answer or diving in and '
      + 'guessing all three without ever surfacing the ambiguity existed. A weak answer '
      + 'either ignores the ambiguity, or produces boilerplate "communication is '
      + 'important" filler without a concrete decision.',
  },
  {
    id: 'quant-02-rate',
    category: 'quantitative',
    description: 'A classic "work rate" problem where one of two pipes stops partway '
      + 'through filling a tank. Measures whether the model tracks a rate that CHANGES '
      + 'across discrete time phases (combined rate for hour 1, then a different rate '
      + 'afterward), rather than applying one naive constant-rate formula to the whole '
      + 'problem.',
    prompt: 'Pipe A can fill a tank in 6 hours. Pipe B can fill the same tank in 3 hours. '
      + 'If both pipes are opened together, but Pipe A is shut off after 1 hour (Pipe B '
      + 'keeps running the whole time), how many total hours does it take to fill the '
      + 'tank from empty? Show your work, then end your reply with a line of the exact '
      + 'form: FINAL ANSWER: <number, decimal or fraction>',
    grader: 'numeric',
    // In 1st hour: A does 1/6, B does 1/3 = 1/6+2/6=3/6=1/2 done. Remaining 1/2 tank,
    // B alone at 1/3 tank/hr -> (1/2)/(1/3) = 1.5 more hours. Total = 1 + 1.5 = 2.5.
    expected: 2.5,
    tolerance: 0.01,
  },
];

module.exports = { CASES };
