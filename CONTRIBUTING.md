# Contributing

Thanks for your interest in Northstar Control. The project is licensed under the
[MIT License](./LICENSE).

## Before opening a pull request

- Explain the user-visible behavior or bug being addressed.
- Keep hardware operations explicit and fail closed when the OS or device does
  not report support.
- Never treat GitHub authentication as authorization to change local hardware.
- Never add credentials, OAuth client secrets, or access tokens to the source.
- For changes to Northstar Control, run `npm test` and `npm run check`.

Hardware controls must use supported operating-system APIs, validate device
capabilities, and respect local authorization. Do not add silent elevation or
success-shaped fallbacks for unavailable controls.
