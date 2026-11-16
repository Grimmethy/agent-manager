# Client-agnostic deny-list format

This document describes the deny-list format implemented by `src/denylist.js`. A deny-list is a plain text file of rules. The module loads the rules, scans a piece of text for matching terms, and returns which matches are denied and which were dismissed by an allow rule. The module writes no files and records no history itself. Callers decide what to do with its results.

Status note: `src/denylist.js` is added by a sibling task. The behavior below is taken from that module's source. Re-check this document against the file once it lands.

## Line grammar

Each line is one rule, except blank lines and comments. A line whose first non-blank character is `#` is a comment. Fields are separated by `|` and each field is trimmed of surrounding whitespace, so a term or placeholder cannot contain `|`.

Deny rules have three fields:

```
kind|term-or-pattern|placeholder
```

Allow rules have two fields and no placeholder:

```
allow|term-or-pattern
```

Parsing details:

- A leading UTF-8 byte-order mark is stripped. Both LF and CRLF line endings are accepted.
- The field count is checked exactly. A deny rule with a field count other than 3, or an allow rule with a field count other than 2, is a load error that names the file and line.
- The term field must not be empty. The placeholder field must be present, but the parser does not reject an empty value.
- An unrecognized kind is a load error. Kind names are case-sensitive.

Example rules file:

```
# Zorblax is a client name
client|Zorblax|[CLIENT]
person|Quendal Vexmart|[PERSON]
id|QV-1042|[ID]
secret|Vexmart Token|[SECRET]
```

## The four kinds

The parser accepts exactly four deny kinds: `client`, `person`, `id`, and `secret`. The module does not assign meaning to a kind beyond reporting it. The kind is copied onto every match and dismissal so that callers can group results.

## Allow rules and per-span semantics

An allow rule names a term that may appear without being denied. Allow rules are scoped to spans, not to the whole text or to a file. A deny match is dismissed only when an allow match in the same scanned text covers it. Coverage means the allow match starts at or before the deny match's start and ends at or after the deny match's end. Otherwise the deny match is reported.

Consequences:

- A deny match that only partly overlaps an allow match is not dismissed.
- Allow rules never add matches. They can only remove deny matches.
- Allow rules themselves are never reported.

Example: with the rule `client|Zorblax Quendal|[CLIENT]` and the rule `allow|Quendal`, the text `Zorblax Quendal` is still reported. The allow match `Quendal` covers only part of the deny match `Zorblax Quendal`, so nothing is dismissed.

## Whole-word matching

Terms are matched case-insensitively and only as whole words. A match must not be directly preceded or followed by a letter, a number, or an underscore. The check is Unicode-aware.

- Plurals and possessives: an optional suffix is part of the match. It is `s`, `'s`, or the curly form of `'s`. So `Zorblax` matches `Zorblax`, `Zorblaxs`, `Zorblax's`, and `Zorblax’s`. The suffix is included in the matched span.
- Initials: words in a term may be separated in the text by spaces or dots. So the term `Quendal V.` matches `Quendal V`, `quendal v.`, and `Quendal.V`. The trailing dot in the term is not required in the text.
- A term with no words, such as `...`, cannot be compiled. It is reported as an error for its rule, and that rule is skipped. Scanning continues with the other rules.

Matching is computed for deny and allow terms before any allow decision is made. A near-miss allow does not dismiss a real hit.

## Missing file

If the rules file does not exist, the loader returns `present: false` with an empty rule list and does not raise an error. Scanning with no rules produces no matches and no dismissals. A missing file therefore means that no deny rules apply. It does not mean that everything is allowed. Callers can check `present` to tell the two cases apart. Any other read error is thrown.

## Dismissal record fields

`scanText` returns an object with `matches`, `dismissed`, `errors`, and `stats`. Both `matches` and `dismissed` are sorted by `start`.

Each dismissed entry has these fields:

- `kind`: the deny rule's kind.
- `term`: the deny rule's term.
- `start` and `end`: character offsets of the match in the scanned text.
- `line`: the 1-based line number of the match.
- `text`: the matched text, including any suffix.
- `file`: the file label the caller passed in.
- `allowTerm`: the term of the allow rule that covered the match.

Each entry in `matches` has the same fields except `allowTerm`. It also has `placeholder`, the placeholder from the deny rule.

Each entry in `errors` has `file`, `line`, `term`, and `message`.

The `stats` object has `matched` (number of matches), `dismissedByAllow` (number of dismissals), and `termsLoaded` (number of rules loaded).

The dismissal record is returned in memory. The module does not write a history event and does not persist a counter. `stats.dismissedByAllow` is the only count it reports.
