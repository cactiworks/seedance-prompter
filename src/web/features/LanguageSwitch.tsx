import { SegmentedControl } from '../ui/components/index.ts';
import { useLanguage, type LanguageChoice } from '../language.ts';

export function LanguageSwitch() {
  const [language, setLanguage] = useLanguage();
  return (
    <SegmentedControl<LanguageChoice>
      aria-label="Language"
      size="s"
      value={language}
      onChange={setLanguage}
      options={[
        { value: 'ru', label: 'RU', title: 'Русский' },
        { value: 'en', label: 'EN', title: 'English' },
      ]}
    />
  );
}
