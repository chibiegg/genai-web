import { COPYRIGHT_TEXT, LOGO_IMAGE_URL, LOGO_TEXT } from '@/branding';

type Props = {
  className?: string;
};

export const Footer = (props: Props) => {
  const { className } = props;

  return (
    <footer
      className={`flex flex-col items-center gap-y-2 p-6 text-std-16N-170 ${className ?? ''}`}
    >
      {LOGO_IMAGE_URL ? (
        <img src={LOGO_IMAGE_URL} alt={LOGO_TEXT} className='h-8' />
      ) : (
        <p>{LOGO_TEXT}</p>
      )}
      <p>{COPYRIGHT_TEXT}</p>
    </footer>
  );
};
