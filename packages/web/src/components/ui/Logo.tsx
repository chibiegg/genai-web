import { Link } from 'react-router';
import { LOGO_IMAGE_URL, LOGO_TEXT } from '@/branding';

type Props = {
  isLandingPage?: boolean;
};

const logoTypographyStyles = 'text-std-20B-150 leading-120! text-black';

const LogoContent = () =>
  LOGO_IMAGE_URL ? <img src={LOGO_IMAGE_URL} alt={LOGO_TEXT} className='h-8' /> : <>{LOGO_TEXT}</>;

export const Logo = (props: Props) => {
  const { isLandingPage } = props;
  return (
    <div className='relative flex gap-2 items-center lg:gap-4'>
      {isLandingPage ? (
        <h1 className={`${logoTypographyStyles}`}>
          <LogoContent />
        </h1>
      ) : (
        <Link
          to='/'
          className={`${logoTypographyStyles} focus-visible:rounded-4 focus-visible:bg-yellow-300 focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300 focus-visible:outline-4 focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:outline-black focus-visible:outline-solid`}
        >
          <LogoContent />
        </Link>
      )}
    </div>
  );
};
