import { Icon, SegmentedControl } from '../ui/components/index.ts';
import { useTheme, type ThemeChoice } from '../theme.ts';

/** Светлая · тёмная · как в системе. Выбор запоминается в этом браузере. */
export function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  return (
    <SegmentedControl<ThemeChoice>
      aria-label="Тема"
      size="s"
      value={theme}
      onChange={setTheme}
      options={[
        { value: 'light', label: <Icon name="sun" size={1} />, title: 'Светлая тема' },
        { value: 'dark', label: <Icon name="moon" size={1} />, title: 'Тёмная тема' },
        { value: 'system', label: 'Авто', title: 'Как в системе' },
      ]}
    />
  );
}
