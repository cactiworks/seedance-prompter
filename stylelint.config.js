// Гейт дизайн-системы: в CSS приложения допустимы только токены Lab UI (var(--lab-*)).
// Сырые цвета, радиусы и тени запрещены везде, кроме генерируемых файлов токенов.
const RAW_COLOR = ['/#[0-9a-fA-F]{3,8}\\b/', '/\\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\\(/'];

export default {
  extends: ['stylelint-config-standard'],
  ignoreFiles: ['dist/**', 'node_modules/**', 'src/web/ui/tokens/**'],
  rules: {
    'selector-class-pattern': null,
    'custom-property-pattern': null,
    // Порядок состояний (hover → active → disabled) читается лучше, чем сортировка по специфичности.
    'no-descending-specificity': null,
    'property-no-vendor-prefix': [true, { ignoreProperties: ['text-size-adjust', 'font-smoothing'] }],
    'declaration-property-value-disallowed-list': [
      {
        '/^(color|background|background-color|border|border-color|outline|outline-color|fill|stroke|caret-color|box-shadow|text-shadow)$/':
          RAW_COLOR,
        '/^border(-(top|bottom)-(left|right))?-radius$/': ['/^\\d/'],
      },
      { message: 'Только токены Lab UI: var(--lab-*). Сырые цвета, радиусы и тени запрещены.' },
    ],
  },
};
