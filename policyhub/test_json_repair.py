"""The model's JSON, when it is not quite JSON.

Reported from use: reading an illustration and an LE report failed after
two minutes with

    Expecting ',' delimiter: line 24 column 1 (char 13673)

which reads like a structural fault and is not one. The free-text fields
— the underwriter's assessment, the extraction notes — are prose, and
prose invites a real line break. JSON forbids one inside a string, so the
parse stops at the line after it and a run that had already done all the
work is lost.

Repairing that is safe, and this is the proof: valid input comes back
byte-identical, and only control characters inside a string are rewritten.

Run:  python3 test_json_repair.py
"""
import json
import os
import sys

os.environ.setdefault('ANTHROPIC_API_KEY', 'not-used-here')
os.environ.setdefault('JOBS_DIR', '/tmp/valjobs-test')
import app  # noqa: E402

fails = []


def check(name, ok, extra=''):
    print(f"{'  PASS' if ok else '  FAIL'}  {name}{f' — {extra}' if extra else ''}")
    if not ok:
        fails.append(name)


def parses(text, test=None):
    try:
        d = app._loads_forgiving(text)
    except ValueError:
        return False
    return test(d) if test else True


print('A RAW LINE BREAK INSIDE A VALUE IS REPAIRED, NOT FATAL')

# The shape of the reported failure.
check('prose with a real line break in it parses',
      parses('{"a": 1,\n "note": "Risk is higher.\nRecords through April.",\n "b": 2}',
             lambda d: d['note'].count('\n') == 1 and d['b'] == 2))
check('a tab inside a value survives as a tab',
      parses('{"n": "a\tb"}', lambda d: d['n'] == 'a\tb'))
check('an escaped quote either side of the break is kept',
      parses('{"n": "he said \\"no\\"\nand left"}', lambda d: '"no"' in d['n']))
check('a bare control character becomes an escape, not a crash',
      parses('{"n": "a\x01b"}', lambda d: d['n'] == 'a\x01b'))

print('\nNOTHING VALID IS DISTURBED')

check('an escaped newline is left exactly as written',
      parses('{"x": "a\\nb"}', lambda d: d['x'] == 'a\nb'))
check('line breaks BETWEEN fields are structure, not content',
      parses('{\n  "a": 1,\n  "b": "two"\n}', lambda d: d['b'] == 'two'))

big = json.dumps({
    'ledger': {str(i): {'prem': i * 1.5, 'note': 'line one\nline two', 'q': 'say "hi"'}
               for i in range(300)},
    'name': 'Delp, Cleves', 'nested': [{'a': None, 'b': True}], 'unicode': 'né—ø',
})
check('a large valid document comes back byte-identical',
      app._json_escape_control(big) == big)
check('and still parses to the same object',
      json.loads(app._json_escape_control(big)) == json.loads(big))

print('\nWHAT IS GENUINELY BROKEN STILL FAILS, USEFULLY')

try:
    app._loads_forgiving('{"a": 1, "b": }')
    check('malformed JSON is refused', False, 'it was accepted')
except ValueError as e:
    check('malformed JSON is refused', True)
    check('and the message names the line rather than the character offset',
          'line' in str(e) and 'reading by hand' in str(e), str(e)[:80])

print()
print(f'{len(fails)} JSON REPAIR CHECK(S) FAILED:\n  ' + '\n  '.join(fails)
      if fails else 'ALL JSON REPAIR CHECKS PASSED')
sys.exit(1 if fails else 0)
