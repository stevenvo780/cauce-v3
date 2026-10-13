INSERT INTO harness_definitions(id,display_name,capabilities) VALUES
  ('grok','Grok','["messages.receive","jobs.interactive","jobs.batch"]'::jsonb),
  ('muse','Muse Code','["messages.receive","jobs.interactive","jobs.batch"]'::jsonb),
  ('fake2','Fake QA 2','["messages.receive","ack.timeline"]'::jsonb)
ON CONFLICT(id) DO NOTHING;
