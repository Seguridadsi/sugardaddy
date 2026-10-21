//go:build !unix

package main

import "os"

func ocupado(fi os.FileInfo) int64 { return fi.Size() }
