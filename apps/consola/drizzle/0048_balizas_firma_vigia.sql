CREATE TABLE "nonces_vigia" (
	"token" text NOT NULL,
	"nonce" text NOT NULL,
	"hora" timestamp with time zone NOT NULL,
	CONSTRAINT "nonces_vigia_token_nonce_pk" PRIMARY KEY("token","nonce")
);
--> statement-breakpoint
ALTER TABLE "balizas" ADD COLUMN "clave" text;--> statement-breakpoint
ALTER TABLE "balizas" ADD COLUMN "firma_exigida" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nonces_vigia" ADD CONSTRAINT "nonces_vigia_token_balizas_token_fk" FOREIGN KEY ("token") REFERENCES "public"."balizas"("token") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nonces_vigia_hora" ON "nonces_vigia" USING btree ("token","hora");