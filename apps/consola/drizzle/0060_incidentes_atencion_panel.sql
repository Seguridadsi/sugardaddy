-- Lo que atiende el panel solo frena el escalado hacia SeguridadSI, no el aviso local
-- (docs/diseno/frenos-del-nodo.md). Columnas nuevas y nulas: una consola anterior las ignora.
ALTER TABLE "incidentes_motor" ADD COLUMN "atencion_panel" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidentes_motor" ADD COLUMN "atencion_panel_por" text;