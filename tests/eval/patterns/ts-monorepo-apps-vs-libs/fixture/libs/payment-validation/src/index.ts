export function isValidCardNumber(number: string): boolean {
    if (!/^\d{13,19}$/.test(number)) return false;
    let sum = 0;
    let alt = false;
    for (let i = number.length - 1; i >= 0; i--) {
        let digit = parseInt(number[i], 10);
        if (alt) { digit *= 2; if (digit > 9) digit -= 9; }
        sum += digit;
        alt = !alt;
    }
    return sum % 10 === 0;
}
