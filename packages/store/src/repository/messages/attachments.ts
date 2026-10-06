export const MESSAGE_ATTACHMENTS_SQL = `COALESCE(CASE WHEN jsonb_typeof(m.body->'attachments_v1')='array' THEN (
  SELECT jsonb_agg(jsonb_build_object(
           'name',entry.attachment->'name','mime_type',entry.attachment->'mime_type',
           'file_size',entry.attachment->'file_size','sha256',entry.attachment->'sha256'
         ) ORDER BY entry.position)
  FROM jsonb_array_elements(m.body->'attachments_v1')
       WITH ORDINALITY AS entry(attachment,position)
) END,'[]'::jsonb) AS attachments`;

export const MESSAGE_BODY_PREVIEW_SQL =
  `left(COALESCE(m.body->>'text',m.body->>'prompt',(m.body-'attachments_v1'::text)::text),240) AS body_preview`;
