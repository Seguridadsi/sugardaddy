CREATE TABLE "plantillas" (
	"id" text PRIMARY KEY NOT NULL,
	"nombre" text NOT NULL,
	"descripcion" text NOT NULL,
	"entorno" text,
	"piezas" jsonb NOT NULL,
	"quien" text NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL,
	"cambiado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trampas" ADD COLUMN "plantilla" text;