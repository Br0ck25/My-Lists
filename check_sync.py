# Verifies that worker_entry_combined.js is exactly what build.py produces.
#
# This used to check something much weaker: that each numbered source file
# appeared SOMEWHERE inside the combined file. That passes on a combined file
# with the modules in the wrong order, with a module duplicated, or with extra
# content appended after the last one -- none of which build.py can produce, so
# the check could only ever agree with a build that had already gone right.
#
# verify.sh and CI never used it; both rebuild and diff, which is the real
# check. Rather than leave a weaker duplicate around to be trusted by mistake,
# this now does the same thing they do, and can be run on its own:
#
# "The same thing they do" includes ignoring line endings, which this did not.
# Both of those compare with `git diff --ignore-cr-at-eol`; this compared raw
# bytes. worker_entry_combined.js is committed with CRLF while the numbered
# sources are committed with LF, so on a clean checkout the byte compare
# always failed -- and told you to run build.py, which would rewrite the whole
# 3.3MB file with LF endings and commit a diff of nothing but line-ending
# churn (CI, ignoring CR at EOL, would not have objected). It now normalises
# the same way, so the only mismatch it reports is a real one:
#
#   python3 check_sync.py
#
# Exits non-zero, and says where the first difference is, if the committed
# Worker is not byte-for-byte what the sources build to.
import glob
import sys

expected = bytearray(open("header.js", "rb").read())
for name in sorted(glob.glob("[0-9][0-9]_*.js")):
    data = open(name, "rb").read()
    expected += data
    if not data.endswith(b"\n"):
        expected += b"\r\n"

actual = open("worker_entry_combined.js", "rb").read()

# Normalised exactly like `git diff --ignore-cr-at-eol`: a trailing CR before a
# newline is not a difference. Everything below compares the normalised forms,
# so a reported byte offset points at real content, not at a line ending.
def lf(b):
    return b.replace(b"\r\n", b"\n")

expected = bytearray(lf(bytes(expected)))
actual = lf(actual)

if bytes(expected) == actual:
    print(f"  ok: worker_entry_combined.js matches its sources ({len(actual):,} bytes, line endings ignored)")
    sys.exit(0)

print(f"  MISMATCH: expected {len(expected):,} bytes, found {len(actual):,}")
for i in range(min(len(expected), len(actual))):
    if expected[i] != actual[i]:
        lo, hi = max(0, i - 60), i + 60
        print(f"  first difference at byte {i:,}")
        print(f"    built:     {bytes(expected[lo:hi])!r}")
        print(f"    committed: {actual[lo:hi]!r}")
        break
else:
    print("  one is a prefix of the other -- content was added or truncated at the end")
print("  run: python3 build.py")
sys.exit(1)
