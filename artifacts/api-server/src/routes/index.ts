import { Router, type IRouter } from "express";
import healthRouter from "./health";
import arbRouter from "./arb";
import bmexFundingRouter from "./bmex-funding";
import strcRouter from "./strc";

const router: IRouter = Router();

router.use(healthRouter);
router.use(arbRouter);
router.use(bmexFundingRouter);
router.use(strcRouter);

export default router;
