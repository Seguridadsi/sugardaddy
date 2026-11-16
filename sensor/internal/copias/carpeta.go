package copias

// Un destino que es una carpeta montada: la de la carpeta compartida SMB, tal
// como la ve el auxiliar (smb.go). Escribe a un .tmp y lo renombra: una copia
// a medias nunca tiene el nombre de una copia.

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// Carpeta es el destino en una carpeta del sistema de ficheros.
type Carpeta struct{ Raiz string }

func (c Carpeta) ruta(nombre string) (string, error) {
	if !NombreCopia.MatchString(nombre) {
		return "", errors.New("not a backup name")
	}
	return filepath.Join(c.Raiz, nombre), nil
}

func (c Carpeta) Subir(_ context.Context, nombre, ruta, _ string, _ int64) error {
	destino, err := c.ruta(nombre)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(c.Raiz, 0o700); err != nil {
		return err
	}
	src, err := os.Open(ruta)
	if err != nil {
		return err
	}
	defer src.Close()
	tmp := destino + ".tmp"
	dst, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, src)
	if err == nil {
		err = dst.Sync()
	}
	if e := dst.Close(); err == nil {
		err = e
	}
	if err == nil {
		err = os.Rename(tmp, destino)
	}
	if err != nil {
		_ = os.Remove(tmp)
	}
	return err
}

func (c Carpeta) Listar(context.Context) ([]Remota, error) {
	entradas, err := os.ReadDir(c.Raiz)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Remota
	for _, e := range entradas {
		if !e.Type().IsRegular() || !NombreCopia.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, Remota{Nombre: e.Name(), Bytes: info.Size()})
	}
	Ordenar(out)
	return out, nil
}

func (c Carpeta) Borrar(_ context.Context, nombre string) error {
	r, err := c.ruta(nombre)
	if err != nil {
		return err
	}
	if err := os.Remove(r); err != nil && !errors.Is(err, os.ErrNotExist) {
		if errors.Is(err, os.ErrPermission) {
			// Una carpeta con WORM o con la escritura sin borrado: se dice como bloqueada.
			return errors.Join(ErrBloqueada, err)
		}
		return err
	}
	return nil
}

func (c Carpeta) Bajar(_ context.Context, nombre string, w io.Writer) error {
	r, err := c.ruta(nombre)
	if err != nil {
		return err
	}
	f, err := os.Open(r)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(w, f)
	return err
}
