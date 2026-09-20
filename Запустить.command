#!/bin/bash
# Двойной клик: запускает Seedance Prompter и открывает вкладку в браузере.
cd "$(dirname "$0")" || exit 1
if [ ! -d node_modules ]; then echo "Первый запуск: ставлю зависимости…"; npm install --no-audit --no-fund || exit 1; fi
npm start
