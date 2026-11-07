package com.example.towerdefense;

import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

import java.util.Comparator;
import java.util.List;

public class TowerBlockEntity extends BlockEntity {
    private static final double RANGE = 10;
    private int cooldown = 0;

    public TowerBlockEntity(BlockPos pos, BlockState state) {
        super(ModBlocks.TOWER_BE.get(), pos, state);
    }

    public static void tick(Level level, BlockPos pos, BlockState state, TowerBlockEntity be) {
        if (be.cooldown > 0) { be.cooldown--; return; }

        AABB area = new AABB(pos).inflate(RANGE);
        List<Monster> targets = level.getEntitiesOfClass(Monster.class, area);
        if (targets.isEmpty()) return;

        Vec3 center = Vec3.atCenterOf(pos);
        Monster target = targets.stream()
            .min(Comparator.comparingDouble(m -> m.distanceToSqr(center)))
            .get();

        target.hurt(level.damageSources().magic(), 4f);
        be.cooldown = 20; // 1 секунда
    }
}
