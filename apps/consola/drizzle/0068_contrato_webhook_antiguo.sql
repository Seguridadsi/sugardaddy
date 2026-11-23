-- Contrato de eventos v1 (D9): los webhooks que ya existían siguen con su
-- formato de antes. Sin esto, al editar uno el formulario propondría «v1» y
-- el receptor del cliente dejaría de entender lo que le llega.
UPDATE "salidas"
SET "configuracion" = "configuracion" || '{"contrato":"antiguo"}'::jsonb
WHERE "tipo" = 'webhook' AND NOT ("configuracion" ? 'contrato');
