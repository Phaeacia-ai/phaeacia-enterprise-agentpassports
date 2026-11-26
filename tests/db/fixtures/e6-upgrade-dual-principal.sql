-- E6 upgrade dual-principal seed (docs/e6/design.md 1.1, E6D-C-F1c). TEST ONLY.
--
-- The one data shape migration 008 REFUSES to be applied over: an account that holds both a row in app.operators
-- and a membership. The design's rule makes the two principals disjoint FROM 008 ONWARDS and does not repair a
-- database that already holds a crossing, so 008 carries a one-time check that fails loudly, naming the count and no
-- identity, rather than installing that promise over data nobody has looked at. This file makes the crossing in a
-- scratch database standing at the accepted 007 schema, and probe 30g then applies 008 and observes the refusal.
insert into app.operators (user_id) values ('aaaaaaaa-0000-4000-8000-000000000001');
