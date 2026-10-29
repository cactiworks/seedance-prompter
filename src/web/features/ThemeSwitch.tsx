import { ui } from '../language.ts';
import { Icon, SegmentedControl } from '../ui/components/index.ts';
import { useTheme, type ThemeChoice } from '../theme.ts';
import { useLanguage } from '../language.ts';

/** Светлая · тёмная · как в системе. Выбор запоминается в этом браузере. */
export function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const [language] = useLanguage();
  return (
    <SegmentedControl<ThemeChoice>
      aria-label={language === 'en' ? 'Theme' : ui("Тема")}
      size="s"
      value={theme}
      onChange={setTheme}
      options={[
        { value: 'light', label: <Icon name="sun" size={1} />, title: language === 'en' ? 'Light theme' : ui("Светлая тема") },
        { value: 'dark', label: <Icon name="moon" size={1} />, title: language === 'en' ? 'Dark theme' : ui("Тёмная тема") },
        { value: 'system', label: language === 'en' ? 'Auto' : ui("Авто"), title: language === 'en' ? 'System theme' : ui("Как в системе") },
      ]}
    />
  );
}
