"""
Clarification text folding utilities.

Provides fold_answer() to prepend a human design decision block to raw text,
preserving any prior decision blocks and the original task text.
"""

ORIGINAL_MARKER = 'ORIGINAL TASK TEXT (read it for context; ignore any instruction the decision above reverses):'


def DECISION_HEADER(stamp: str) -> str:
    """Build a decision header string from a stamp identifier."""
    return f'HUMAN DESIGN DECISION ({stamp}; where anything below conflicts with this decision, the decision wins and the conflicting old line is void):'


def _extract_prior_decisions(prefix: str) -> str:
    """Extract all prior decision blocks from the prefix portion of raw text.
    
    Returns them joined by double newlines, or empty string if none found.
    """
    if not prefix:
        return ''
    
    marker = 'HUMAN DESIGN DECISION ('
    decisions = []
    start = 0
    
    while True:
        idx = prefix.find(marker, start)
        if idx == -1:
            break
        # Found a decision block starting at idx
        # Find the end: next decision marker or end of string
        end = prefix.find(marker, idx + len(marker))
        if end == -1:
            end = len(prefix)
        decisions.append(prefix[idx:end])
        start = end
    
    return '\n\n'.join(decisions)


def fold_answer(raw_text: str, answer: str, stamp: str) -> str:
    """Fold an answer into raw text with a decision-first block structure.
    
    Splits raw_text on the first ORIGINAL_MARKER, keeps any earlier decision
    blocks verbatim below the new decision, and returns:
    1. The new decision block
    2. A blank line
    3. Prior decisions (if any)
    4. ORIGINAL_MARKER
    5. A newline
    6. The original text unchanged
    
    Args:
        raw_text: The existing raw text (may contain prior decisions and original text)
        answer: The new answer text
        stamp: A stamp identifier for the decision header
        
    Returns:
        The folded text with the new decision block prepended
    """
    decision_header = DECISION_HEADER(stamp)
    
    # Split on first ORIGINAL_MARKER
    if ORIGINAL_MARKER in raw_text:
        idx = raw_text.index(ORIGINAL_MARKER)
        prefix = raw_text[:idx]
        original_text = raw_text[idx:]  # includes the marker
    else:
        prefix = raw_text
        original_text = ''
    
    # Extract prior decision blocks from prefix
    prior_decisions = _extract_prior_decisions(prefix)
    
    # Build result
    result_parts = []
    
    # 1. New decision block
    result_parts.append(f'{decision_header}\n{answer}')
    
    # 2. Blank line
    result_parts.append('')
    
    # 3. Prior decisions if any
    if prior_decisions:
        result_parts.append(prior_decisions)
        # Blank line before ORIGINAL section
        result_parts.append('')
    
    # 4. ORIGINAL_MARKER section
    result_parts.append(ORIGINAL_MARKER)
    
    # 5. Original text (everything after the marker)
    if original_text:
        # original_text starts with ORIGINAL_MARKER, strip it
        result_parts.append(original_text[len(ORIGINAL_MARKER):])
    
    result = '\n'.join(result_parts)
    
    # Ensure proper trailing newline if there's content
    if result and not result.endswith('\n'):
        result += '\n'
    
    return result
