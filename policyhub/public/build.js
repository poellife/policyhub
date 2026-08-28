/* =====================================================================
   Which build this is.

   One constant, imported by both halves of the application: the server
   reads it here and reports it on /auth/me, and the browser reads the
   same file when the page loads. If the two disagree, the deployment is
   half one build and half another.

   That is not a hypothetical. It has happened twice: a new Reports screen
   served against an older API that had never heard of a "reports" export,
   and a new Edit button on a ledger against an API with no route behind
   it. Both surfaced as a bare error code with nothing to act on, and both
   cost a round trip to work out. A version that the application checks
   against itself turns that into a sentence anybody can read.

   Bump this whenever the application is packaged. Any string will do so
   long as it changes; a date and a letter is enough to say which is
   newer, which is the only comparison a person actually makes.
   ===================================================================== */

export const BUILD = '2026-08-28c';
