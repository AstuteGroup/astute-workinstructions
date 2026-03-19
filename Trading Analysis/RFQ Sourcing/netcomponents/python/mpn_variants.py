"""
MPN Variant Prioritization Module

Classifies MPN suffixes and determines match types between
customer-requested MPNs and supplier-offered MPNs.

Match Types:
- EXACT: Exact match (NUP2105L → NUP2105L)
- PACKAGING_SAFE: T&R variant when customer didn't specify packaging
- PACKAGING_MISMATCH: Tubes/trays when customer requested T&R (or vice versa)
- COMPLIANCE: RoHS/lead-free variant (G, G4, PBF, etc.)
- SPEC: Temperature, automotive, military qualification change
- UNKNOWN: Unrecognized suffix
"""

import re
from dataclasses import dataclass
from typing import Optional, List, Tuple


# =============================================================================
# Suffix Patterns
# =============================================================================

# NOTE: Order matters - more specific patterns must be checked before general ones
# The patterns use word boundaries and specific delimiters to avoid false matches
# (e.g., "TUBE" should not match the "E" temperature grade suffix)

# Packaging suffixes - generally safe when customer doesn't specify
# Tape & Reel variants
PACKAGING_TAPE_REEL = re.compile(
    r'[-#]?(T&R|T&REEL|TR|TR\d+|T1|REEL|TAPE)$',
    re.IGNORECASE
)

# Tube/Tray/Other packaging
PACKAGING_TUBE_TRAY = re.compile(
    r'[-#]?(TUBE|TRAY|BULK|CUT|RAIL)$',
    re.IGNORECASE
)

# RoHS/Compliance suffixes - risky, spec change
# G4 must be checked before G (more specific first)
COMPLIANCE_SUFFIXES = re.compile(
    r'[-#]?(G4|G|PBF|PBFREE|LF|NOPB|ROHS|Z)$',
    re.IGNORECASE
)

# Automotive qualification - risky, different qualification
# Q1 must be checked before Q (more specific first)
AUTO_SUFFIXES = re.compile(
    r'[-#]?(Q1|Q|AEC)$',
    re.IGNORECASE
)

# Military/aerospace - risky
MIL_SUFFIXES = re.compile(
    r'[-#]?(883|/883|JANTXV|JANTX|JAN|MIL|CSMR|/CSMR)$',
    re.IGNORECASE
)

# Temperature grade suffixes - risky, different operating range
# IMPORTANT: Only match single letters when they appear after a delimiter
# to avoid matching letters within words like "TUBE"
TEMP_SUFFIXES = re.compile(
    r'[-#](E|I|M|C)$',  # Require delimiter before single letters
    re.IGNORECASE
)


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class ParsedMPN:
    """Parsed MPN with base part and suffix information."""
    original: str
    base: str
    suffixes: List[str]
    has_packaging: bool
    packaging_type: Optional[str]  # 'tape_reel', 'tube_tray', or None
    has_compliance: bool
    has_temp_grade: bool
    has_auto_qual: bool
    has_mil_qual: bool


@dataclass
class MatchResult:
    """Result of comparing requested MPN to offered MPN."""
    match_type: str  # EXACT, PACKAGING_SAFE, PACKAGING_MISMATCH, COMPLIANCE, SPEC, UNKNOWN
    requested_mpn: str
    offered_mpn: str
    variant_flags: List[str]  # Human-readable flags like 'G=RoHS', 'T1=T&R'
    details: str  # Explanation for flagged items


# =============================================================================
# Parsing Functions
# =============================================================================

def extract_suffixes(mpn: str) -> Tuple[str, List[str]]:
    """
    Extract suffixes from an MPN, returning base part and list of suffixes.

    Works iteratively from the end of the MPN to handle stacked suffixes.
    Example: NUP2105LT1G → ('NUP2105L', ['T1', 'G'])

    Important: Patterns are checked in order of specificity (most specific first)
    to avoid partial matches (e.g., G4 before G, Q1 before Q).
    """
    if not mpn:
        return '', []

    original = mpn.strip()
    current = original
    suffixes = []

    # Iteratively strip suffixes from the end
    # Check more specific patterns first (G4 before G, Q1 before Q, etc.)
    max_iterations = 6  # Safety limit
    for _ in range(max_iterations):
        found_suffix = False

        # Order matters: check multi-char patterns before single-char
        # Also check packaging patterns before temp grades to avoid
        # false matches (e.g., TUBE matching -E)
        patterns = [
            PACKAGING_TAPE_REEL,      # T&R, TR, T1, REEL, TAPE
            PACKAGING_TUBE_TRAY,      # TUBE, TRAY, BULK, CUT, RAIL
            MIL_SUFFIXES,             # JANTXV, JANTX, JAN, MIL, 883
            AUTO_SUFFIXES,            # Q1, Q, AEC
            COMPLIANCE_SUFFIXES,      # G4, G, PBF, LF, NOPB, ROHS, Z
            TEMP_SUFFIXES,            # E, I, M, C (requires delimiter)
        ]

        for pattern in patterns:
            match = pattern.search(current)
            if match:
                suffix = match.group(1)
                suffixes.insert(0, suffix)  # Prepend to maintain order
                current = current[:match.start()]
                found_suffix = True
                break

        if not found_suffix:
            break

    return current, suffixes


def classify_suffix(suffix: str) -> Tuple[str, str]:
    """
    Classify a single suffix.

    Returns: (category, human_readable_description)
    Categories: 'packaging_tr', 'packaging_other', 'compliance', 'temp', 'auto', 'mil', 'unknown'
    """
    s = suffix.upper().lstrip('-#/')

    # Tape & Reel packaging
    if re.match(r'^(T&R|T&REEL|TR|TR\d+|T1|REEL|TAPE)$', s, re.IGNORECASE):
        return 'packaging_tr', f'{suffix}=T&R'

    # Tube/Tray/Other packaging
    if re.match(r'^(TUBE|TRAY|BULK|CUT|RAIL)$', s, re.IGNORECASE):
        return 'packaging_other', f'{suffix}=Tube/Tray'

    # Compliance/RoHS (check G4 before G)
    if re.match(r'^(G4|G|PBF|PBFREE|LF|NOPB|ROHS|Z)$', s, re.IGNORECASE):
        return 'compliance', f'{suffix}=RoHS'

    # Automotive (check Q1 before Q)
    if re.match(r'^(Q1|Q|AEC)$', s, re.IGNORECASE):
        return 'auto', f'{suffix}=Automotive'

    # Military
    if re.match(r'^(883|/883|JANTXV|JANTX|JAN|MIL|CSMR|/CSMR)$', s, re.IGNORECASE):
        return 'mil', f'{suffix}=Military'

    # Temperature grade (single letters)
    if re.match(r'^[EIMC]$', s):
        grades = {'E': 'Extended', 'I': 'Industrial', 'M': 'Military', 'C': 'Commercial'}
        return 'temp', f'{suffix}={grades.get(s, "Temp")}'

    return 'unknown', suffix


def parse_mpn(mpn: str) -> ParsedMPN:
    """
    Parse an MPN into its components.

    Args:
        mpn: The MPN string to parse

    Returns:
        ParsedMPN with base part and suffix classifications
    """
    if not mpn:
        return ParsedMPN(
            original='',
            base='',
            suffixes=[],
            has_packaging=False,
            packaging_type=None,
            has_compliance=False,
            has_temp_grade=False,
            has_auto_qual=False,
            has_mil_qual=False
        )

    base, suffixes = extract_suffixes(mpn.strip())

    has_packaging = False
    packaging_type = None
    has_compliance = False
    has_temp_grade = False
    has_auto_qual = False
    has_mil_qual = False

    for suffix in suffixes:
        category, _ = classify_suffix(suffix)

        if category == 'packaging_tr':
            has_packaging = True
            packaging_type = 'tape_reel'
        elif category == 'packaging_other':
            has_packaging = True
            packaging_type = 'tube_tray'
        elif category == 'compliance':
            has_compliance = True
        elif category == 'temp':
            has_temp_grade = True
        elif category == 'auto':
            has_auto_qual = True
        elif category == 'mil':
            has_mil_qual = True

    return ParsedMPN(
        original=mpn.strip(),
        base=base,
        suffixes=suffixes,
        has_packaging=has_packaging,
        packaging_type=packaging_type,
        has_compliance=has_compliance,
        has_temp_grade=has_temp_grade,
        has_auto_qual=has_auto_qual,
        has_mil_qual=has_mil_qual
    )


# =============================================================================
# Match Type Determination
# =============================================================================

def get_match_type(requested_mpn: str, offered_mpn: str) -> MatchResult:
    """
    Determine match type between customer-requested MPN and supplier-offered MPN.

    Implements bidirectional packaging logic:
    - T&R variants are SAFE when customer didn't specify packaging
    - Tubes/trays are PACKAGING_MISMATCH when customer requested T&R
    - Compliance/spec changes are always flagged

    Args:
        requested_mpn: What the customer asked for
        offered_mpn: What the supplier is offering

    Returns:
        MatchResult with match type, flags, and details
    """
    req = parse_mpn(requested_mpn)
    off = parse_mpn(offered_mpn)

    # Build human-readable flags for the offered MPN's suffixes
    variant_flags = []
    for suffix in off.suffixes:
        _, flag = classify_suffix(suffix)
        variant_flags.append(flag)

    # Normalize for comparison (case-insensitive)
    req_orig_upper = req.original.upper()
    off_orig_upper = off.original.upper()
    req_base_upper = req.base.upper()
    off_base_upper = off.base.upper()

    # === EXACT MATCH ===
    if req_orig_upper == off_orig_upper:
        return MatchResult(
            match_type='EXACT',
            requested_mpn=requested_mpn,
            offered_mpn=offered_mpn,
            variant_flags=[],
            details=''
        )

    # Base parts must match for any other comparison
    if req_base_upper != off_base_upper:
        return MatchResult(
            match_type='UNKNOWN',
            requested_mpn=requested_mpn,
            offered_mpn=offered_mpn,
            variant_flags=variant_flags,
            details=f'Base parts differ: {req.base} vs {off.base}'
        )

    # === COMPLIANCE/SPEC CHANGES (always flag) ===
    # Check if offered has compliance changes not in requested
    if off.has_compliance and not req.has_compliance:
        return MatchResult(
            match_type='COMPLIANCE',
            requested_mpn=requested_mpn,
            offered_mpn=offered_mpn,
            variant_flags=variant_flags,
            details='RoHS/compliance variant - may not be acceptable if leaded required'
        )

    if off.has_temp_grade and not req.has_temp_grade:
        return MatchResult(
            match_type='SPEC',
            requested_mpn=requested_mpn,
            offered_mpn=offered_mpn,
            variant_flags=variant_flags,
            details='Temperature grade variant - different operating range'
        )

    if off.has_auto_qual and not req.has_auto_qual:
        return MatchResult(
            match_type='SPEC',
            requested_mpn=requested_mpn,
            offered_mpn=offered_mpn,
            variant_flags=variant_flags,
            details='Automotive qualification variant'
        )

    if off.has_mil_qual and not req.has_mil_qual:
        return MatchResult(
            match_type='SPEC',
            requested_mpn=requested_mpn,
            offered_mpn=offered_mpn,
            variant_flags=variant_flags,
            details='Military qualification variant'
        )

    # === PACKAGING LOGIC (bidirectional) ===

    # Customer requested T&R specifically
    if req.packaging_type == 'tape_reel':
        if off.packaging_type == 'tube_tray' or (off.has_packaging == False and req.has_packaging):
            # Customer wants T&R but supplier offers tubes/trays or base part
            return MatchResult(
                match_type='PACKAGING_MISMATCH',
                requested_mpn=requested_mpn,
                offered_mpn=offered_mpn,
                variant_flags=variant_flags,
                details='Customer requested T&R but supplier offers tubes/trays - harder sell'
            )

    # Customer requested tubes/trays specifically
    if req.packaging_type == 'tube_tray':
        if off.packaging_type == 'tape_reel':
            # Customer wants tubes but supplier offers T&R
            return MatchResult(
                match_type='PACKAGING_MISMATCH',
                requested_mpn=requested_mpn,
                offered_mpn=offered_mpn,
                variant_flags=variant_flags,
                details='Customer requested tubes/trays but supplier offers T&R - cost/handling different'
            )

    # Customer didn't specify packaging (base part)
    if not req.has_packaging:
        if off.has_packaging:
            # T&R is almost always acceptable when not specified
            if off.packaging_type == 'tape_reel':
                return MatchResult(
                    match_type='PACKAGING_SAFE',
                    requested_mpn=requested_mpn,
                    offered_mpn=offered_mpn,
                    variant_flags=variant_flags,
                    details='T&R variant - almost always acceptable'
                )
            else:
                # Tubes/trays also generally fine when not specified
                return MatchResult(
                    match_type='PACKAGING_SAFE',
                    requested_mpn=requested_mpn,
                    offered_mpn=offered_mpn,
                    variant_flags=variant_flags,
                    details='Packaging variant - generally acceptable'
                )

    # If we get here, there are suffix differences we don't fully understand
    # but none of the risky categories matched
    return MatchResult(
        match_type='UNKNOWN',
        requested_mpn=requested_mpn,
        offered_mpn=offered_mpn,
        variant_flags=variant_flags,
        details=f'Suffix differences: {req.suffixes} vs {off.suffixes}'
    )


# =============================================================================
# Priority Integration
# =============================================================================

def match_type_priority(match_type: str) -> int:
    """
    Return priority multiplier for match type.
    Higher = better priority.

    Used to adjust the overall supplier priority score.
    """
    priorities = {
        'EXACT': 100,
        'PACKAGING_SAFE': 90,
        'PACKAGING_MISMATCH': 50,  # Still viable but lower priority
        'COMPLIANCE': 30,          # Flag for review
        'SPEC': 20,                # Flag for review
        'UNKNOWN': 40,             # Unknown is middle ground
    }
    return priorities.get(match_type, 40)


def should_flag_for_review(match_type: str) -> bool:
    """Return True if this match type should be flagged for manual review."""
    return match_type in ('COMPLIANCE', 'SPEC', 'PACKAGING_MISMATCH')


# =============================================================================
# Testing / Examples
# =============================================================================

if __name__ == '__main__':
    # Test suffix extraction first
    print('Suffix Extraction Tests')
    print('=' * 70)
    extraction_tests = [
        'NUP2105L',
        'NUP2105LT1',
        'NUP2105LT1G',
        'LM358N-G4',
        'LTC2446IUHF#TRPBF',
        'LTC2446IUHF#PBF',
        'MAX232-E',
        'ADM3202ARUZ-REEL',
    ]
    for mpn in extraction_tests:
        base, suffixes = extract_suffixes(mpn)
        print(f'{mpn:25} → base: {base:20} suffixes: {suffixes}')
    print()

    # Test match types
    test_cases = [
        # (requested, offered, expected_match_type)
        # Exact matches
        ('NUP2105L', 'NUP2105L', 'EXACT'),
        ('LM358N', 'LM358N', 'EXACT'),

        # Packaging safe (T&R when not specified)
        ('NUP2105L', 'NUP2105LT1', 'PACKAGING_SAFE'),
        ('NUP2105L', 'NUP2105L-TR', 'PACKAGING_SAFE'),
        ('ADM3202ARUZ', 'ADM3202ARUZ-REEL', 'PACKAGING_SAFE'),

        # Compliance variants (RoHS change)
        ('NUP2105L', 'NUP2105LT1G', 'COMPLIANCE'),
        ('NUP2105L', 'NUP2105LG', 'COMPLIANCE'),
        ('LM358N', 'LM358N-G4', 'COMPLIANCE'),

        # Packaging mismatch (customer wants T&R, supplier offers base/tube)
        ('NUP2105LT1', 'NUP2105L', 'PACKAGING_MISMATCH'),
        ('NUP2105L-TR', 'NUP2105L', 'PACKAGING_MISMATCH'),

        # Temperature grade
        ('MAX232', 'MAX232-E', 'SPEC'),
    ]

    print('Match Type Tests')
    print('=' * 70)

    passed = 0
    failed = 0
    for req, off, expected in test_cases:
        result = get_match_type(req, off)
        status = '✓' if result.match_type == expected else '✗'
        if result.match_type == expected:
            passed += 1
        else:
            failed += 1
        print(f'{status} {req:20} → {off:20} = {result.match_type}')
        if result.variant_flags:
            print(f'    Flags: {", ".join(result.variant_flags)}')
        if result.details:
            print(f'    {result.details}')
        if result.match_type != expected:
            print(f'    EXPECTED: {expected}')
        print()

    print(f'Results: {passed} passed, {failed} failed')
