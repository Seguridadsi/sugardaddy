CREATE TABLE "artefactos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evento" uuid NOT NULL,
	"tipo" text NOT NULL,
	"nombre" text,
	"sha256" text,
	"bytes" bigint,
	"ref" text,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artefactos" ADD CONSTRAINT "artefactos_evento_eventos_id_fk" FOREIGN KEY ("evento") REFERENCES "public"."eventos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artefactos_evento" ON "artefactos" USING btree ("evento");