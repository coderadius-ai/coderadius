import chalk from 'chalk';
import { rawLogo } from './logo-data.js';

export const CR_LOGO_LARGE_2 = rawLogo.map(line => chalk.cyan(line));
export const CR_LOGO_LARGE = rawLogo.map(line => chalk.cyan(line));

export const CR_ICON = chalk.cyan('⬢');

export function printHeader(title: string, subtitle?: string) {
    console.log('');
    CR_LOGO_LARGE.forEach((line, i) => {
        if (i === 2) {
            console.log(`${line}  ${chalk.bold.white(title)}`);
        } else if (i === 3 && subtitle) {
            console.log(`${line}  ${chalk.dim(subtitle)}`);
        } else {
            console.log(line);
        }
    });
    console.log('');
}
