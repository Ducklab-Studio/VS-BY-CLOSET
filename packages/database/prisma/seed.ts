import { PrismaClient, Role, UserStatus, ProductStatus } from '@prisma/client';
import { hash } from 'argon2';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seed iniciado...');

  // ── Admin ────────────────────────────────────────────────────────────────
  const adminPassword = await hash('Admin@123');
  const admin = await prisma.user.upsert({
    where: { email: 'admin@loja.com.br' },
    update: {},
    create: {
      name: 'Administrador',
      email: 'admin@loja.com.br',
      passwordHash: adminPassword,
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      emailVerified: new Date(),
    },
  });
  console.log(`✔ Admin: ${admin.email} (senha: Admin@123)`);

  // ── Cliente demo ───────────────────────────────────────────────────────────
  const customerPassword = await hash('Cliente@123');
  await prisma.user.upsert({
    where: { email: 'cliente@loja.com.br' },
    update: {},
    create: {
      name: 'Cliente Demo',
      email: 'cliente@loja.com.br',
      passwordHash: customerPassword,
      role: Role.CUSTOMER,
      status: UserStatus.ACTIVE,
      emailVerified: new Date(),
    },
  });
  console.log('✔ Cliente demo: cliente@loja.com.br (senha: Cliente@123)');

  // ── Marcas ─────────────────────────────────────────────────────────────────
  const brand = await prisma.brand.upsert({
    where: { slug: 'urban-style' },
    update: {},
    create: { name: 'Urban Style', slug: 'urban-style' },
  });

  // ── Categorias ───────────────────────────────────────────────────────────────
  const masculino = await prisma.category.upsert({
    where: { slug: 'masculino' },
    update: {},
    create: { name: 'Masculino', slug: 'masculino', position: 1 },
  });
  const feminino = await prisma.category.upsert({
    where: { slug: 'feminino' },
    update: {},
    create: { name: 'Feminino', slug: 'feminino', position: 2 },
  });

  // ── Produtos de exemplo ──────────────────────────────────────────────────────
  const demoProducts = [
    {
      name: 'Camiseta Básica Premium',
      slug: 'camiseta-basica-premium',
      sku: 'CAM-001',
      price: 89.9,
      promoPrice: 69.9,
      category: masculino.id,
      featured: true,
      colors: [
        { color: 'Preto', hex: '#000000' },
        { color: 'Branco', hex: '#FFFFFF' },
      ],
      sizes: ['P', 'M', 'G', 'GG'],
    },
    {
      name: 'Vestido Floral Verão',
      slug: 'vestido-floral-verao',
      sku: 'VES-001',
      price: 159.9,
      promoPrice: 129.9,
      category: feminino.id,
      featured: true,
      colors: [{ color: 'Floral Azul', hex: '#4A6FA5' }],
      sizes: ['P', 'M', 'G'],
    },
    {
      name: 'Calça Jeans Slim',
      slug: 'calca-jeans-slim',
      sku: 'CAL-001',
      price: 199.9,
      promoPrice: null,
      category: masculino.id,
      featured: false,
      colors: [{ color: 'Azul Escuro', hex: '#1B3A5C' }],
      sizes: ['38', '40', '42', '44'],
    },
  ];

  for (const p of demoProducts) {
    const product = await prisma.product.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        name: p.name,
        slug: p.slug,
        sku: p.sku,
        description:
          'Peça de alta qualidade, confortável e durável. Tecido premium com acabamento impecável.',
        material: '100% Algodão',
        weightGrams: 300,
        widthCm: 30,
        heightCm: 5,
        lengthCm: 40,
        price: p.price,
        promoPrice: p.promoPrice ?? undefined,
        pixDiscountPct: 5,
        maxInstallments: 6,
        status: ProductStatus.ACTIVE,
        isFeatured: p.featured,
        isNewArrival: true,
        brandId: brand.id,
        categories: { create: { categoryId: p.category } },
        media: {
          create: [
            { url: 'https://placehold.co/600x800?text=' + encodeURIComponent(p.name), position: 0 },
          ],
        },
      },
    });

    // variações (cor x tamanho) + estoque
    for (const c of p.colors) {
      for (const size of p.sizes) {
        const variantSku = `${p.sku}-${c.color.slice(0, 3).toUpperCase()}-${size}`;
        const variant = await prisma.productVariant.upsert({
          where: { sku: variantSku },
          update: {},
          create: {
            productId: product.id,
            sku: variantSku,
            color: c.color,
            colorHex: c.hex,
            size,
          },
        });
        await prisma.inventory.upsert({
          where: { variantId: variant.id },
          update: {},
          create: { variantId: variant.id, quantity: 25, lowStockAt: 5 },
        });
      }
    }
    console.log(`✔ Produto: ${product.name}`);
  }

  // ── Cupom de exemplo ─────────────────────────────────────────────────────────
  await prisma.coupon.upsert({
    where: { code: 'BEMVINDO10' },
    update: {},
    create: {
      code: 'BEMVINDO10',
      description: '10% de desconto na primeira compra',
      type: 'PERCENTAGE',
      value: 10,
      maxUsesPerUser: 1,
      isActive: true,
    },
  });
  console.log('✔ Cupom: BEMVINDO10');

  // ── Configurações iniciais da loja ───────────────────────────────────────────
  await prisma.setting.upsert({
    where: { key: 'store' },
    update: {},
    create: {
      key: 'store',
      value: {
        name: 'Minha Loja',
        instagram: '@minhaloja',
        whatsapp: '5511999999999',
        freeShippingThreshold: 299.9,
      },
    },
  });

  console.log('✅ Seed concluído!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
