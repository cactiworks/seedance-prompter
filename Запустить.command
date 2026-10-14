#!/bin/bash
# Двойной клик: запускает Seedance Prompter и открывает вкладку в браузере.
cd "$(dirname "$0")" || exit 1
node scripts/start.ts
