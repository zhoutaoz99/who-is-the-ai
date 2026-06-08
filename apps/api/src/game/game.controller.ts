import { Controller, Get, Param } from "@nestjs/common";
import { GameService } from "./game.service";

@Controller("rooms")
export class GameController {
  constructor(private readonly gameService: GameService) {}

  @Get(":roomId")
  async getRoom(@Param("roomId") roomId: string) {
    return this.gameService.observeRoom({ roomId });
  }
}
