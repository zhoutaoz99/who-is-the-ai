import { Body, Controller, Get, Headers, Patch, Post } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthRequestPayload, ProfileUpdatePayload } from "./auth.types";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  register(@Body() payload: AuthRequestPayload) {
    return this.authService.register(payload ?? {});
  }

  @Post("login")
  login(@Body() payload: AuthRequestPayload) {
    return this.authService.login(payload ?? {});
  }

  @Get("me")
  async me(@Headers("authorization") authorization: string | undefined) {
    const user = await this.authService.getPublicAccountByToken(
      this.getBearerToken(authorization),
    );

    if (!user) {
      return {
        ok: false,
        error: "未登录或登录已过期",
      };
    }

    return {
      ok: true,
      user,
    };
  }

  @Post("logout")
  async logout(@Headers("authorization") authorization: string | undefined) {
    return this.authService.logout(this.getBearerToken(authorization));
  }

  @Patch("profile")
  async updateProfile(
    @Headers("authorization") authorization: string | undefined,
    @Body() payload: ProfileUpdatePayload,
  ) {
    return this.authService.updateProfile(
      this.getBearerToken(authorization),
      payload ?? {},
    );
  }

  private getBearerToken(authorization: string | undefined) {
    const value = (authorization ?? "").trim();
    if (!value.toLowerCase().startsWith("bearer ")) {
      return "";
    }

    return value.slice(7).trim();
  }
}
