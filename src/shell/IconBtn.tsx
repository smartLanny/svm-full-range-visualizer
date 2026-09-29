import React, { forwardRef } from 'react';
import { IconButton as UiIconButton, cn, type IconButtonProps } from '../ui';

/**
 * ui/IconButton with the horizontal padding forced to 0: Button's size classes (px-2/px-2.5)
 * otherwise win over IconButton's px-0 in the generated CSS and squeeze the icon.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ className, ...rest }, ref) {
  return <UiIconButton ref={ref} className={cn('!px-0', className)} {...rest} />;
});
