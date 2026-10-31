CREATE TABLE "silencios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patron" text NOT NULL,
	"hasta" timestamp with time zone NOT NULL,
	"motivo" text,
	"quien" text NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triaje" (
	"evento" uuid PRIMARY KEY NOT NULL,
	"estado" text NOT NULL,
	"nota" text,
	"quien" text NOT NULL,
	"cuando" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "triaje" ADD CONSTRAINT "triaje_evento_eventos_id_fk" FOREIGN KEY ("evento") REFERENCES "public"."eventos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "silencios_hasta" ON "silencios" USING btree ("hasta");--> statement-breakpoint
CREATE INDEX "triaje_estado" ON "triaje" USING btree ("estado");