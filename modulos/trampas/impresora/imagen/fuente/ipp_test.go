package main

import (
	"bytes"
	"testing"
)

// peticionGPA arma una petición Get-Printer-Attributes con los atributos de
// operación que se le indiquen, en orden, para probar la validación.
func peticionGPA(ver [2]byte, reqID uint32, attrs func(*bytes.Buffer)) []byte {
	var b bytes.Buffer
	b.WriteByte(ver[0])
	b.WriteByte(ver[1])
	b.WriteByte(byte(opGetPrinterAttrs >> 8))
	b.WriteByte(byte(opGetPrinterAttrs))
	b.WriteByte(byte(reqID >> 24))
	b.WriteByte(byte(reqID >> 16))
	b.WriteByte(byte(reqID >> 8))
	b.WriteByte(byte(reqID))
	b.WriteByte(tagOperation)
	if attrs != nil {
		attrs(&b)
	}
	b.WriteByte(tagEnd)
	return b.Bytes()
}

func charsetLangURI(b *bytes.Buffer) {
	attrStr(b, tagCharset, "attributes-charset", "utf-8")
	attrStr(b, tagLanguage, "attributes-natural-language", "en")
	attrStr(b, tagURI, "printer-uri", "ipp://x/ipp/print")
}

// TestIPPValidar: la validación da los mismos estados que RFC 8011 §4.1 exige
// y que comprueba ipptool (ipp-1.1.test).
func TestIPPValidar(t *testing.T) {
	casos := []struct {
		nombre string
		pet    []byte
		quiere uint16
	}{
		{"bien", peticionGPA([2]byte{1, 1}, 1, charsetLangURI), estOK},
		{"request-id 0", peticionGPA([2]byte{1, 1}, 0, charsetLangURI), estPeticionMala},
		{"version 0.0", peticionGPA([2]byte{0, 0}, 1, charsetLangURI), estVersionNoSop},
		{"sin atributos de operación", peticionGPA([2]byte{1, 1}, 1, nil), estPeticionMala},
		{"sin charset", peticionGPA([2]byte{1, 1}, 1, func(b *bytes.Buffer) {
			attrStr(b, tagLanguage, "attributes-natural-language", "en")
			attrStr(b, tagURI, "printer-uri", "ipp://x/ipp/print")
		}), estPeticionMala},
		{"sin natural-language", peticionGPA([2]byte{1, 1}, 1, func(b *bytes.Buffer) {
			attrStr(b, tagCharset, "attributes-charset", "utf-8")
			attrStr(b, tagURI, "printer-uri", "ipp://x/ipp/print")
		}), estPeticionMala},
		{"desordenados", peticionGPA([2]byte{1, 1}, 1, func(b *bytes.Buffer) {
			attrStr(b, tagLanguage, "attributes-natural-language", "en")
			attrStr(b, tagCharset, "attributes-charset", "utf-8")
			attrStr(b, tagURI, "printer-uri", "ipp://x/ipp/print")
		}), estPeticionMala},
		{"sin printer-uri", peticionGPA([2]byte{1, 1}, 1, func(b *bytes.Buffer) {
			attrStr(b, tagCharset, "attributes-charset", "utf-8")
			attrStr(b, tagLanguage, "attributes-natural-language", "en")
		}), estPeticionMala},
		{"ilegible", []byte{0x01, 0x01}, estPeticionMala},
	}
	for _, c := range casos {
		pet := decodificarIPP(c.pet)
		if got := pet.validar(); got != c.quiere {
			t.Errorf("%s: validar()=%#x, se esperaba %#x", c.nombre, got, c.quiere)
		}
	}
}
