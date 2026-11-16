CREATE TABLE "certificados_sensor" (
	"huella" text PRIMARY KEY NOT NULL,
	"sensor" text NOT NULL,
	"serie" text NOT NULL,
	"estado" text NOT NULL,
	"desde" timestamp with time zone NOT NULL,
	"hasta" timestamp with time zone NOT NULL,
	"visto" timestamp with time zone,
	"revocado" timestamp with time zone,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certificados_sensor" ADD CONSTRAINT "certificados_sensor_sensor_sensores_id_fk" FOREIGN KEY ("sensor") REFERENCES "public"."sensores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "certificados_sensor_sensor" ON "certificados_sensor" USING btree ("sensor","estado");